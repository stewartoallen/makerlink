module.exports = (function MakerLinkModule() {

	'use strict';

	var events = require('events'),
		net	   = require('net'),
		maxQ   = 1,
		ncWait = 10;

	var MakerLink = function() {
		this.conn = new NetConn();

		this.conn.on('payload', function (payload) {
			var q = this.queue,
				fn = q.shift();
			if (fn) fn(payload);
			this.callOnReady();
		}.bind(this));

		this.conn.on('error', function(error) {
			console.log({error:error});
			this.errors.push(error);
		}.bind(this));

		this.state = {
			build: { //current build state
				name: null,
				state: null,
				flag: 0, // raw flag associated with state
				hours: 0,
				minutes: 0
			},
			board: { // motherboard status flags
				info: [],
				flags: 0
			},
			tool: [{},{},{},{}], // tool status
			playback: 0, // status of playback command
			capture: {}, // state of playback capture
			sdcard: [], // contents of SD card
			buffer: 0, // available command buffer
			version: {}, // board SW versions
			busy: false
		};

		this.queue = [];
		this.queueOut = [];
		this.errors = [];
		this.onReadyQ = [];
	};

	var MLP = MakerLink.prototype;

	// used for some command execution pre-checks
	function isIdle() {
		return this.state.busy;
	}

	MLP.resetComms = function() {
		this.conn.drain();
		this.queue = [];
		this.callOnReady();
	};

	MLP.open = function(host, port) {
		this.conn.open(host, port);
		//this.clearBuffer();
		return this;
	};

	MLP.close = function() {
		this.conn.drain();
	};

	MLP.callOnReady = function() {
		this.checkQueueOut();
		var i = 0, q = this.queue, onr = this.onReadyQ, err = this.errors, call;
		if (q.length > 0 && err.length === 0) return;
		while (i < onr.length) {
			call = onr[i++];
			if (call.error && err.length > 0) call.error(err);
			if (call.done && q.length === 0) call.done(this);
		}
		this.onReadyQ = [];
		this.errors = [];
	};

	MLP.onReady = function(done, error, timeout) {
		this.onReadyQ.push({done:done, error:error, timeout:timeout});
		this.callOnReady();
		return this;
	};

	MLP.checkError = function(check, value, error) {
		if (check !== value) {
			this.errors.push(error || ('unexpected response: '+value));
			this.resetComms();
			return true;
		}
		return false;
	};

	MLP.queueCommand = function(packet, callback, prerun) {
		this.queueOut.push({packet:packet, callback:callback, prerun:prerun});
		this.checkQueueOut();
		return this;
	};

	MLP.checkQueueOut = function() {
		while (this.queueOut.length > 0 && this.queue.length < maxQ) {
			var next = this.queueOut.shift();
			if (next.prerun && !next.prerun()) continue;
			this.queue.push(next.callback || checkSuccess);
			this.conn.write(next.packet);
		}
	};

	/** HOST COMMANDS */

	MLP.bootInit = function() {
		return this.queueCommand( hostCommand(HOST_QUERY.BOOT_INIT) );
	}

	/**
	 * docs say this has no return, but it seems to
	 * and the bot will drop serial traffic for a few
	 * milliseconds after this command is ACKd.
	 */
	MLP.clearBuffer = function() {
		return this.queueCommand( hostCommand(HOST_QUERY.CLEAR_BUFFER) );
	}

	MLP.requestBufferFree = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_BUFFER_FREE),
			function (payload) {
				var out = unpack('BL', payload);
				if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.buffer = out[1];
			}.bind(this)
		);
	}

	MLP.resetBot = function() {
		return this.queueCommand( hostCommand(HOST_QUERY.RESET) );
	}

	/**
	 * also clears buffers, so like clearBuffer(), bot
	 * becomes temporarily unresponsive
	 */
	MLP.jobAbort = function() {
		return this.queueCommand( hostCommand(HOST_QUERY.JOB_ABORT) );
	}

	MLP.jobPauseResume = function() {
		return this.queueCommand( hostCommand(HOST_QUERY.JOB_PAUSE_RESUME) );
	}

	MLP.jobSetPercent = function(percent) {
		return this.queueCommand( query2(pack('BB', HOST_QUERY.JOB_PAUSE_RESUME, percent)) );
	}

	/** check if bot is busy with commands in queue */
	MLP.requestBusyState = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.CHECK_BUSY),
			function (payload) {
				if (this.checkError(payload[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.busy = payload[1] === 0;
			}.bind(this)
		);
	}

	MLP.requestBuildName = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_BUILD_NAME),
			function (payload) {
				var out = unpack('BS', payload);
				if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.build.name = out[1];
			}.bind(this)
		);
	}

	MLP.requestBoardState = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_BOARD_STATE),
			function (payload) {
				if (this.checkError(payload[0],RESPONSE_CODE.SUCCESS)) return;
				var bits = payload[1], info = [];
				if (bits & 1) info.push('PREHEAT');
				if (bits & 2) info.push('MANUAL');
				if (bits & 4) info.push('SCRIPT');
				if (bits & 8) info.push('PROCESS');
				if (bits & 16) info.push('BUTTON WAIT');
				if (bits & 32) info.push('CANCELLING');
				if (bits & 64) info.push('HEAT SHUTDOWN');
				if (bits & 128) info.push('POWER ERROR');
				this.state.board.info = info;
				this.state.board.flags = bits;
			}.bind(this)
		);
	};

	MLP.requestBuildStatistics = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_BUILD_STATS),
			function (payload) {
				if (this.checkError(payload[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.build.flag = payload[1];
				this.state.build.state = BUILD_STATE[payload[1]];
				this.state.build.hours = payload[2];
				this.state.build.minutes = payload[3];
			}.bind(this)
		);
	};

	MLP.captureToFile = function(filename) {
		if (!filename) throw "missing filename";
		if (filename.length > MAX_FILE_NAME) throw "filename too long";
		return this.queueCommand(
			query2(pack('BS', HOST_QUERY.CAPTURE_TO_FILE, filename)),
			function (payload) {
				if (this.checkError(payload[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.capture = { begin:payload[1] };
			}.bind(this)
		);
	};

	MLP.endCapture = function(filename) {
		return this.queueCommand(
			query2(pack('B', HOST_QUERY.END_CAPTURE)),
			function (payload) {
				var out = unpack('BL', payload);
				if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.capture.end = out[1];
			}.bind(this)
		);
	};

	MLP.playbackFile = function(filename) {
		if (!filename) throw "missing filename";
		if (filename.length > MAX_FILE_NAME) throw "filename too long";
		return this.requestBusyState().queueCommand(
			query2(pack('BS', HOST_QUERY.PLAY_CAPTURE, filename)),
			function (payload) {
				if (this.checkError(payload[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.playback = payload[1];
			}.bind(this),
			isIdle.bind(this)
		);
	};

	function processFileList(payload) {
		var out = unpack('BBS', payload),
			sd_rc = out[1], // what is SD response code for? always zero?
			file = out[2];
		if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
		if (!more) this.state.sdcard = [];
		if (file && file != '') {
			this.requestFileList(true);
			this.state.sdcard.push(file);
		}
	}

	// will kill a running job
	MLP.requestFileList = function(more) {
		return this.requestBusyState().queueCommand(
			hostCommand(HOST_QUERY.GET_NEXT_FILENAME, 'B', [more ? 0 : 1]),
			processFileList.bind(this),
			isIdle.bind(this)
		);
	};

	MLP.requestVersion = function(filename) {
		return this.queueCommand(
			query2(pack('BI', HOST_QUERY.GET_VERSION, 100)),
			function (payload) {
				var out = unpack('BI', payload);
				if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.version = { firmware: out[1] };
			}.bind(this)
		);
	};

	MLP.requestVersionExt = function(filename) {
		return this.queueCommand(
			query2(pack('BI', HOST_QUERY.GET_VERSION_EXT, 100)),
			function (payload) {
				var out = unpack('BIIBBI', payload);
				if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.version = {
					firmware: out[1],
					internal: out[2],
					variant: out[3],
					res1: out[4],
					res2: out[5]
				};
			}.bind(this)
		);
	};

	MLP.findAxesMinimums = function(axes_bits, rate, timeout) {
		return this.queueCommand(
			query2(pack('BBLI', HOST_QUERY.FIND_AXES_MIN, axes_bits, rate, timeout))
		);
	};

	MLP.findAxesMaximums = function(filename) {
		return this.queueCommand(
			query2(pack('BBLI', HOST_QUERY.FIND_AXES_MAX, axes_bits, rate, timeout))
		);
	};

	/** TOOL COMMANDS */

	MLP.setToolheadTemperature = function(tool, temp) {
		return this.queueCommand(
			toolCommand(tool, TOOL_COMMAND.SET_TOOLHEAD_TEMP, 'i', [temp])
		);
	};

	MLP.requestToolheadTemperature = function(tool) {
		return this.queueCommand(
			toolQuery(tool, TOOL_QUERY.GET_TOOLHEAD_TEMP),
			function (payload) {
				var out = unpack('Bi', payload);
				if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.tool[tool].temp = out[1];
			}.bind(this)
		);
	};

	MLP.requestToolheadTargetTemperature = function(tool) {
		return this.queueCommand(
			toolQuery(tool, TOOL_QUERY.GET_TOOLHEAD_TARGET_TEMP),
			function (payload) {
				var out = unpack('Bi', payload);
				if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
				this.state.tool[tool].temp_target = out[1];
			}.bind(this)
		);
	};

	/**
	 * Wrap TCP conection
	 */
	function NetConn() {
		this.reader = null;
		this.client = null;
		this.buffer = [];
		this.drain = true;
	}

	NetConn.prototype = Object.create(events.EventEmitter.prototype);

	NetConn.prototype.open = function(host,port) {
		if (this.client) throw "already connected";

		this.reader = new StreamReader();
		this.client = new net.Socket();
		this.client.on('data', function(data) { this.process(data) }.bind(this));
		this.client.on('close', function() { this.close() }.bind(this));
		this.client.connect(port, host, function() {
			if (this.buffer.length > 0) {
				for (var i=0; i<this.buffer.length; i++) {
					this.client.write(this.buffer[i]);
				}
			}
			this.buffer = null;
			this.emit("connect", this)
		}.bind(this));

		return this;
	};

	NetConn.prototype.close = function() {
		if (this.client) {
			this.client.destroy();
			this.client = null;
			this.reader = null;
		}
	};

	NetConn.prototype.drain = function() {
		this.drain = true;
	};

	NetConn.prototype.process = function(data) {
		if (this.drain) {
			console.log({drain:data});
			this.drain = false;
			return;
		}
		console.log({read:data});
		try {
			for (var i = 0; i < data.length; i++) {
				this.reader.nextByte(data[i]);
				if (this.reader.isDataReady()) {
					var payload = this.reader.payload;
					this.reader.reset();
					this.emit('payload', payload);
				}
			}
		} catch (err) {
			this.reader.reset();
			this.emit('error', err);
		}
	};

	NetConn.prototype.write = function(data) {
		if (!this.client) throw "not connected";

		this.drain = false;

		if (this.buffer) {
			console.log({write_buffer:data});
			this.buffer.push(data);
		} else {
			console.log({write:data});
			this.client.write(data);
		}
	};

	/**
	 * Read S3G stream and emit packets
	 */

	function StreamReader() {
		this.state = PROTO.WAIT_FOR_HEADER;
		this.payload = undefined;
		this.payloadOffset = 0;
		this.expectedLength = 0;
	}

	StreamReader.prototype.nextByte = function (value) {
		switch (this.state) {
			case PROTO.WAIT_FOR_HEADER:
				if (value !== PROTOCOL_STARTBYTE) {
					throw exception('Packet Header Exception', 'invalid value ('+value+')');
				}
				this.state = PROTO.WAIT_FOR_LENGTH;
				break;
			case PROTO.WAIT_FOR_LENGTH:
				if (value > MAX_PAYLOAD_LENGTH) {
					throw exception('Packet Length Exception', 'length ('+ value +') greater than '+MAX_PAYLOAD_LENGTH);
				}
				this.expectedLength = value;
				this.state = PROTO.WAIT_FOR_DATA;
				break;
			case PROTO.WAIT_FOR_DATA:
				if (!this.payload) {
					this.payload = new ArrayBuffer(this.expectedLength);
				}
				this.payload[this.payloadOffset] = value;
				++this.payloadOffset;
				if (this.payloadOffset > this.expectedLength) {
					throw exception('Packet Length Exception', 'packet length greater than expected');
				} else if (this.payloadOffset === this.expectedLength) {
					this.state = PROTO.WAIT_FOR_CRC;
				}
				break;
			case PROTO.WAIT_FOR_CRC:
				var crc = CRC(this.payload);
				if (crc !== value){
					throw exception('Packet CRC Exception', 'value mismatch');
				}
				this.state = PROTO.PAYLOAD_READY;
				break;
			default:
				throw exception('Parser Exception', 'invalid state');
		}
	};

	StreamReader.prototype.reset = function() {
		this.state = PROTO.WAIT_FOR_HEADER;
		this.payload = undefined;
		this.payloadOffset = 0;
		this.expectedLength = 0;
	};

	StreamReader.prototype.isDataReady = function() {
		return this.state === PROTO.PAYLOAD_READY;
	};

	/**
	 * Stream utility functions
	 */

	function query() {
		var payload = new ArrayBuffer(arguments.length);
		for (var i = 0; i < arguments.length; ++i) {
			payload[i] = arguments[i];
		}
		var packet = encode(payload);
		var buffer = new Buffer(packet.byteLength, false);
		for (var i = 0; i < packet.byteLength; ++i) {
			buffer[i] = packet[i];
		}
		return buffer;
	}

	function query2(packed) {
		var enc = encode(packed),
			len = enc.byteLength,
			buf = new Buffer(len, false),
			i = 0;
		while (i < len) buf[i] = enc[i++];
		return buf;
	}

	function toolAction(tool, command, packed_args) {
		return query2(
			concatArrayBuffers(
				pack('BBBB', HOST_COMMAND.TOOL_ACTION, tool, command, packed_args.byteLength),
				packed_args
			)
		);
	}

	function concatArrayBuffers(a1, a2) {
		var l1 = a1.byteLength,
			l2 = a2.byteLength,
			len = l1 + l2,
			i = 0,
			j = 0,
			nab = new ArrayBuffer(len),
			dv1 = new DataView(a1),
			dv2 = new DataView(a2),
			dv3 = new DataView(nab);
		while (i < l1) dv3.setUint8(i, dv1.getUint8(i++));
		while (j < l2) dv3.setUint8(i + j, dv2.getUint8(j++));
		return nab;
	}

	function toBuffer(ab) {
		var len = ab.byteLength,
			buf = new Buffer(len, false),
			i = 0;
		while (i < len) buf[i] = ab[i++];
		return buf;
	}

	function hostCommand(cmd, def, args) {
		if (!def) {
			def = 'B';
			args = [cmd];
		} else {
			def = 'B' + def;
			args.unshift(cmd);
		}
		var buf = new ArrayBuffer(256),
			off = _pack(def,buf,2,args,0),
			crc = CRC(buf,2,off);
		_pack('BB',buf,0,[PROTOCOL_STARTBYTE,off-2],0);
		_pack('B',buf,off,[crc],0);
		return toBuffer(buf.slice(0,off+1));
	}

	function toolQuery(tool, cmd) {
		return hostCommand(HOST_QUERY.TOOL_QUERY, 'BB', [tool, cmd]);
	}

	function toolCommand(tool, cmd, def, args) {
		var buf = new ArrayBuffer(256),
			off = _pack(def,buf,6,args,0),
			len = _pack('BBBB',buf,2,[HOST_COMMAND.TOOL_ACTION, tool, cmd, off-6],0), 
			crc = CRC(buf,2,off);
		_pack('BB',buf,0,[PROTOCOL_STARTBYTE,off-2],0);
		_pack('B',buf,off,[crc],0);
		return toBuffer(buf.slice(0,off+1));
	}

	function pack(def) {
		var buf = new ArrayBuffer(256),
			off = _pack(def,buf,0,arguments,1);
		return buf.slice(0,off);
	}

	function _pack(def,buf,off,args,argi) {
		var j = 0,
			len = args.length,
			view = new DataView(buf);
		while (argi < len) {
			var param = args[argi++];
			switch (def[j++]) {
				case 'B':
					view.setUint8(off++, param);
					break;
				case 'i':
					view.setInt16(off, param, true);
					off += 2;
					break;
				case 'I':
					view.setUint16(off, param, true);
					off += 2;
					break;
				case 'l':
					view.setInt32(off, param, true);
					off += 4;
					break;
				case 'L':
					view.setUint32(off, param, true);
					off += 4;
					break;
				case 'S':
					for (var x=0; x<param.length; x++) {
						view.setUint8(off++, param.charCodeAt(x));
					}
					view.setUint8(off++, 0);
					break;
				default:
					throw "illegal def: "+def;
			}
		}
		return off;
	}

	function unpack(def,buf) {
		var j = 0,
			off = 0,
			out = [],
			len = buf.byteLength,
			view = new DataView(buf);
		while (j < def.length && off < len) {
			switch (def[j++]) {
				case 'B':
					out.push(view.getUint8(off++));
					break;
				case 'i':
					out.push(view.getInt16(off, true));
					off += 2;
					break;
				case 'I':
					out.push(view.getUint16(off, true));
					off += 2;
					break;
				case 'l':
					out.push(view.getInt32(off, true));
					off += 4;
					break;
				case 'L':
					out.push(view.getUint32(off, true));
					off += 4;
					break;
				case 'S':
					var ch, str = [];
					while ((ch = view.getUint8(off++)) !== 0 && off < len) {
						str.push(String.fromCharCode(ch));
					}
					out.push(str.join(''));
					break;
				default:
					throw "illegal def: "+def;
			}
		}
		return out;
	}

	function encode(payload) {
		if (!payload) {
			throw exception("Argument Exception", 'payload is null or undefined');
		} else if (!(payload instanceof ArrayBuffer)) {
			throw exception("Argument Exception", 'payload is not an ArrayBuffer');
		} else if (payload.byteLength > MAX_PAYLOAD_LENGTH) {
			throw exception("Packet Length Exception", 'payload length (' + payload.byteLength + ') is greater than max ('+ MAX_PAYLOAD_LENGTH + ').');
		}

		var i = 0,
			j = 0,
			len = payload.byteLength,
			packet = new DataView(new ArrayBuffer(len + 3));

		packet.setUint8(i++, PROTOCOL_STARTBYTE);
		packet.setUint8(i++, len);
		while (j < payload.byteLength) packet.setUint8(i++, payload[j++]);
		packet.setUint8(i, CRC(payload));

		return packet;
	}

	function checkSuccess(payload) {
		if (payload[0] !== RESPONSE_CODE.SUCCESS) {
			throw exception("request fail", "response code: "+payload[0], payload[0]);
		}
	}

	function exception(name, message, code) {
		return {"name":name, "message":message, code:code};
	}

	function CRC(payload,off,len) {
		if (!payload) {
			throw exception("Argument Exception", 'payload is null or undefined');
		} else if (!(payload instanceof ArrayBuffer)) {
			throw exception("Argument Exception", 'payload is not an ArrayBuffer');
		}
		var i = off || 0,
			crc = 0,
			max = len || payload.byteLength;
		while (i < max) crc = CRC_TABLE[crc ^ payload[i++]];
		return crc;
	}

	/**
	 * CONSTANTS
	 */

	var PROTOCOL_STARTBYTE = 0xD5,
		MAX_PAYLOAD_LENGTH = 32,
		MAX_FILE_NAME = 32,
		HOST_QUERY = {
			'GET_VERSION'              : 0,
			'BOOT_INIT'                : 1,
			'GET_BUFFER_FREE'          : 2,
			'CLEAR_BUFFER'             : 3,
			'JOB_ABORT'                : 7,
			'JOB_PAUSE_RESUME'         : 8,
			'TOOL_QUERY'               : 10,
			'CHECK_BUSY'               : 11,
			'CAPTURE_TO_FILE'          : 14,
			'END_CAPTURE'              : 15,
			'PLAY_CAPTURE'             : 16,
			'RESET'                    : 17,
			'GET_NEXT_FILENAME'        : 18,
			'GET_BUILD_NAME'           : 20,
			'GET_BOARD_STATE'          : 23,
			'GET_BUILD_STATS'          : 24,
			'GET_VERSION_EXT'          : 27
		},
		HOST_COMMAND = {
			'FIND_AXES_MIN'            : 131,
			'FIND_AXES_MAX'            : 132,
			'DELAY'                    : 133,
			'CHANGE_TOOL'              : 134,
			'WAIT_TOOL_READY'          : 135,
			'TOOL_ACTION'              : 136,
			'SET_BUILD_PERCENT'        : 150
		},
		TOOL_QUERY = {
			'GET_TOOLHEAD_TEMP'        : 2,
			'GET_PLATFORM_TEMP'        : 30,
			'GET_TOOLHEAD_TARGET_TEMP' : 32,
			'GET_PLATFORM_TARGET_TEMP' : 33
		},
		TOOL_COMMAND = {
			'INIT_TOOL'                : 0,
			'SET_TOOLHEAD_TEMP'        : 3,
			'SET_MOTOR_SPEED'          : 6,
			'MOTOR_ENABLE_DISABLE'     : 10,
			'FAN_ENABLE_DISABLE'       : 12,
			'SET_PLATFORM_TEMP'	       : 31
		},
		RESPONSE_CODE = {
			'GENERIC_PACKET_ERROR'    : 0x80,
			'SUCCESS'                 : 0x81,
			'ACTION_BUFFER_OVERFLOW'  : 0x82,
			'CRC_MISMATCH'            : 0x83,
			'COMMAND_NOT_SUPPORTED'   : 0x85,
			'DOWNSTREAM_TIMEOUT'      : 0x87,
			'TOOL_LOCK_TIMEOUT'	      : 0x88,
			'CANCEL_BUILD'            : 0x89,
			'ACTIVE_LOCAL_BUILD'      : 0x8A,
			'OVERHEAT_STATE'          : 0x8B
		},
		BUILD_STATE = {
			'0' : "Idle",
			'1' : "Running",
			'2' : "Complete",
			'3' : "Paused",
			'4' : "Cancelled",
			'5' : "None Active"
		},
		CRC_TABLE = [
			0, 94, 188, 226, 97, 63, 221, 131, 194, 156, 126, 32, 163, 253, 31, 65,
			157, 195, 33, 127, 252, 162, 64, 30, 95, 1, 227, 189, 62, 96, 130, 220,
			35, 125, 159, 193, 66, 28, 254, 160, 225, 191, 93, 3, 128, 222, 60, 98,
			190, 224, 2, 92, 223, 129, 99, 61, 124, 34, 192, 158, 29, 67, 161, 255,
			70, 24, 250, 164, 39, 121, 155, 197, 132, 218, 56, 102, 229, 187, 89, 7,
			219, 133, 103, 57, 186, 228, 6, 88, 25, 71, 165, 251, 120, 38, 196, 154,
			101, 59, 217, 135, 4, 90, 184, 230, 167, 249, 27, 69, 198, 152, 122, 36,
			248, 166, 68, 26, 153, 199, 37, 123, 58, 100, 134, 216, 91, 5, 231, 185,
			140, 210, 48, 110, 237, 179, 81, 15, 78, 16, 242, 172, 47, 113, 147, 205,
			17, 79, 173, 243, 112, 46, 204, 146, 211, 141, 111, 49, 178, 236, 14, 80,
			175, 241, 19, 77, 206, 144, 114, 44, 109, 51, 209, 143, 12, 82, 176, 238,
			50, 108, 142, 208, 83, 13, 239, 177, 240, 174, 76, 18, 145, 207, 45, 115,
			202, 148, 118, 40, 171, 245, 23, 73, 8, 86, 180, 234, 105, 55, 213, 139,
			87, 9, 235, 181, 54, 104, 138, 212, 149, 203, 41, 119, 244, 170, 72, 22,
			233, 183, 85, 11, 136, 214, 52, 106, 43, 117, 151, 201, 74, 20, 246, 168,
			116, 42, 200, 150, 21, 75, 169, 247, 182, 232, 10, 84, 215, 137, 107, 53
		],
		PROTO = {
			WAIT_FOR_HEADER: 0,
			WAIT_FOR_LENGTH: 1,
			WAIT_FOR_DATA: 2,
			WAIT_FOR_CRC: 3,
			PAYLOAD_READY: 4
		};

	return MakerLink;

})();

