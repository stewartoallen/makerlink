module.exports = (function MakerLinkModule() {

	'use strict';

	var events = require('events'),
		net	   = require('net'),
		fs     = require('fs'),
		maxQ   = 1;

	function MakerLink() {
		this.conn = new NetConn();

		this.conn.on('payload', function (payload) {
			var q = this.queueIn,
				fn = q.shift().bind(this);
			if (fn) fn(payload);
			this.callOnReady();
		}.bind(this));

		this.conn.on('error', function(error) {
			console.log({error:error});
			this.errors.push(error);
			throw error;
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

		this.queueIn = [];
		this.queueOut = [];
		this.errors = [];
		this.onReadyQ = [];
	}

	var MLP = MakerLink.prototype;

	// used for some command execution pre-checks
	function isIdle() {
		return !this.state.busy;
	}

	MLP.resetComms = function() {
		this.conn.drain();
		this.queueIn = [];
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
		var i = 0, q = this.queueIn, onr = this.onReadyQ, err = this.errors, call;
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
		while (this.queueOut.length > 0 && this.queueIn.length < maxQ) {
			var next = this.queueOut.shift();
			if (next.prerun && !next.prerun.bind(this)()) continue;
			this.queueIn.push(next.callback || checkSuccess);
			this.conn.write(next.packet);
		}
	};

	/** HOST COMMANDS */

	MLP.bootInit = function() {
		return this.queueCommand( hostCommand(HOST_QUERY.BOOT_INIT) );
	};

	/**
	 * docs say this has no return, but it seems to
	 * and the bot will drop serial traffic for a few
	 * milliseconds after this command is ACKd.
	 */
	MLP.clearBuffer = function() {
		return this.queueCommand( hostCommand(HOST_QUERY.CLEAR_BUFFER) );
	};

	MLP.requestBufferFree = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_BUFFER_FREE),
			hostReply('L', function(out) { this.state.buffer = out[0] })
		);
	};

	MLP.resetBot = function() {
		return this.queueCommand( hostCommand(HOST_QUERY.RESET) );
	};

	/**
	 * also clears buffers, so like clearBuffer(), bot
	 * becomes temporarily unresponsive
	 */
	MLP.jobAbort = function() {
		return this.queueCommand(hostCommand(HOST_QUERY.JOB_ABORT));
	};

	MLP.jobPauseResume = function() {
		return this.queueCommand(hostCommand(HOST_QUERY.JOB_PAUSE_RESUME));
	};

	MLP.jobSetPercent = function(percent) {
		return this.queueCommand(hostCommand(HOST_QUERY.JOB_PAUSE_RESUME, 'B', [percent]));
	};

	/** check if bot is busy with commands in queue */
	MLP.requestBusyState = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.CHECK_BUSY),
			hostReply('B', function(out) { this.state.busy = (out[0] === 0) })
		);
	};

	MLP.requestBuildName = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_BUILD_NAME),
			hostReply('S', function(out) { this.state.build.name = out[0] })
		);
	};

	MLP.requestBoardState = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_BOARD_STATE),
			hostReply('B', function(out) {
				var bits = out[0], info = [];
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
			})
		);
	};

	MLP.requestBuildStatistics = function() {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_BUILD_STATS),
			hostReply('BBBB', function(out) {
				this.state.build.flag = out[0];
				this.state.build.state = BUILD_STATE[out[0]];
				this.state.build.hours = out[1];
				this.state.build.minutes = out[2];
			})
		);
	};

	MLP.captureToFile = function(filename) {
		if (!filename) throw "missing filename";
		if (filename.length > MAX_FILE_NAME) throw "filename too long";
		return this.queueCommand(
			hostCommand(HOST_QUERY.CAPTURE_TO_FILE, 'S', [filename]),
			hostReply('B', function(out) { this.state.capture = { begin:out[0] } })
		);
	};

	MLP.endCapture = function(filename) {
		return this.queueCommand(
			hostCommand(HOST_QUERY.END_CAPTURE),
			hostReply('L', function(out) { this.state.capture.end = out[0] })
		);
	};

	// will kill a running job ... check idle
	MLP.playbackFile = function(filename) {
		if (!filename) throw "missing filename";
		if (filename.length > MAX_FILE_NAME) throw "filename too long";
		return this.requestBusyState().queueCommand(
			hostCommand(HOST_QUERY.PLAY_CAPTURE, 'S', [filename]),
			hostReply('B', function(out) { this.state.playback = out[0] }),
			isIdle
		);
	};

	// will kill a running job ... check idle
	MLP.requestFileList = function(more) {
		if (!more) this.requestBusyState();
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_NEXT_FILENAME, 'B', [more ? 0 : 1]),
			hostReply('BS', function(out) {
				var sd_rc = out[0], // what is SD response code for? always zero?
					file = out[1];
				if (!more) this.state.sdcard = [];
				if (file && file != '') {
					this.requestFileList(true);
					this.state.sdcard.push(file);
				}
			}),
			isIdle
		);
	};

	MLP.requestVersion = function(filename) {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_VERSION, 'I', [100]),
			hostReply('I', function(out) { this.state.version = out[0] })
		);
	};

	MLP.requestVersionExt = function(filename) {
		return this.queueCommand(
			hostCommand(HOST_QUERY.GET_VERSION_EXT, 'I', [100]),
			hostReply('IIBBI', function(out) {
				this.state.version = {
					firmware: out[0],
					internal: out[1],
					variant: out[2],
					res1: out[3],
					res2: out[4]
				};
			})
		);
	};

	MLP.findAxesMinimums = function(axes_bits, rate, timeout) {
		return this.queueCommand(
			hostCommand(HOST_QUERY.FIND_AXES_MIN, 'BLI', [axes_bits, rate, timeout])
		);
	};

	MLP.findAxesMaximums = function(filename) {
		return this.queueCommand(
			hostCommand(HOST_QUERY.FIND_AXES_MAX, 'BLI', [axes_bits, rate, timeout])
		);
	};

	/** TOOL COMMANDS */

	MLP.setToolheadTemperature = function(tool, temp) {
		return this.queueCommand(
			toolCommand(tool, TOOL_CMD.SET_TOOLHEAD_TEMP, 'i', [temp])
		);
	};

	MLP.requestToolheadTemperature = function(tool) {
		return this.queueCommand(
			toolQuery(tool, TOOL_QUERY.GET_TOOLHEAD_TEMP),
			hostReply('i', function(out) { this.state.tool[tool].temp = out[0] })
		);
	};

	MLP.requestToolheadTargetTemperature = function(tool) {
		return this.queueCommand(
			toolQuery(tool, TOOL_QUERY.GET_TOOLHEAD_TARGET_TEMP),
			hostReply('i', function(out) { this.state.tool[tool].temp_target = out[0] })
		);
	};

	MLP.sendFile = function(filename) {
		var reader = fs.readFile(filename, function(err, data) {
			var stream = new FileReader();
			for (var i=0; i<data.length; i++) {
				stream.nextByte(data[i]);
				if (stream.isDataReady()) {
					var payload = stream.getPacket();
					this.queueCommand(toBuffer(payload));
				}
			}
		}.bind(this));
		return this;
	};

	MLP.readFile = function(filename) {
		fs.readFile(filename, function(err, data) {
			if (err) throw err;
			console.log({read:(typeof data), len:data.length});
			var stream = new FileReader();
			for (var i=0; i<data.length; i++) {
				stream.nextByte(data[i]);
				if (stream.isDataReady()) {
					var payload = stream.getPacket();
					console.log({data:payload});
				}
			}
		});
	};

	/**
	 * Wrap TCP conection
	 */
	function NetConn() {
		this.reader = null;
		this.client = null;
		this.buffer = [];
		this.drain = true;
		this.pre = new Buffer([PROTOCOL_STARTBYTE,0]);
		this.crc = new Buffer([0]);
	}

	NetConn.prototype = Object.create(events.EventEmitter.prototype);

	NetConn.prototype.open = function(host,port) {
		if (this.client) throw "already connected";

		this.reader = new StreamReader();
		this.client = new net.Socket();
		this.client.on('data', function(data) { this.receive(data) }.bind(this));
		this.client.on('close', function() { this.close() }.bind(this));
		this.client.connect(port, host, function() {
			this.writeBuffered();
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

	NetConn.prototype.receive = function(data) {
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
					this.emit('payload', this.reader.getPayload());
				}
			}
		} catch (err) {
			this.reader.reset();
			this.emit('error', err);
		}
	};

	/**
	 * write buffer to net prepending protocol header and length
	 * and appending a crc
	 *
	 * @param {Buffer} data
	 */
	NetConn.prototype.write = function(data) {
		if (!this.client) throw "not connected";

		this.drain = false;

		if (this.buffer) {
			console.log({write_buffer:data});
			this.buffer.push(data);
		} else {
			console.log({write:data,len:data.length});
			this.pre[1] = data.length;
			this.crc[0] = crcCalc(data);
			this.client.write(this.pre);
			this.client.write(data);
			this.client.write(this.crc);
		}
	};

	NetConn.prototype.writeBuffered = function() {
		var buf = this.buffer, len = buf.length, i = 0;
		this.buffer = null;
		while (i < len) this.write(buf[i++]);
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
				var crc = crcCalc(this.payload);
				if (crc !== value){
					throw exception('Packet CRC Exception', 'value mismatch');
				}
				this.state = PROTO.PAYLOAD_READY;
				break;
			default:
				throw exception('Parser Exception', 'invalid state');
		}
	};

	StreamReader.prototype.getPayload = function() {
		var payload = this.payload;
		this.state = PROTO.WAIT_FOR_HEADER;
		this.payload = undefined;
		this.payloadOffset = 0;
		this.expectedLength = 0;
		return payload;
	};

	StreamReader.prototype.isDataReady = function() {
		return this.state === PROTO.PAYLOAD_READY;
	};

	/**
	 * Read S3G stream and emit packets
	 */

	function FileReader() {
		this.cmd_id = 0;
		this.cmd_def = null;
		this.def_pos = 0;
		this.writepos = 0;
		this.expect = 0;
		this.to_null = false;
		this.buffer = new ArrayBuffer(256);
		this.view = new DataView(this.buffer);
		this.last_value = 0;
	}

	FileReader.prototype.nextByte = function (value) {
		this.view.setUint8(this.writepos++, value);
		this.last_value = value;
		if (this.cmd_id === 0) {
			this.cmd_id = value;
			this.cmd_def = HCMD_DEC[value];
			if (!this.cmd_def) {
				this.writepos--;
				this.cmd_id = 0;
				console.log('invalid cmd: '+value);
				return;
			}
console.log({name:HCMD_DESC[value]});
			this.def_pos = 0;
			this.expect = 0;
			this.to_null = false;
			//return;
		}
		if (this.to_null) {
//console.log({wait_null:value});
			if (value !== 0) return;
			this.to_null = false;
		}
		else if (this.expect && --this.expect > 0) {
//console.log({expect:this.expect, value:value});
			return;
		}
//console.log({next_def:this.def_pos,from:this.cmd_def});
		switch (this.cmd_def[this.def_pos++]) {
			case 'B': this.expect = 1; break;
			case 'i': this.expect = 2; break;
			case 'I': this.expect = 2; break;
			case 'l': this.expect = 4; break;
			case 'L': this.expect = 4; break;
			case 'f': this.expect = 4; break;
			case 'S': this.to_null = true; this.expect = 0; break;
			case '[': this.expect = this.last_value; break;
		}
	};

	FileReader.prototype.getPacket = function() {
		var packet = this.buffer.slice(0,this.writepos);
		this.cmd_id = 0;
		this.cmd_def = null;
		this.writepos = 0;
		this.expect = 0;
		this.to_null = false;
		this.buffer = new ArrayBuffer(256);
		this.view = new DataView(this.buffer);
		return packet;
	};

	FileReader.prototype.isDataReady = function() {
		return this.cmd_id !== 0 && this.def_pos > this.cmd_def.length;
	};

	/**
	 * Stream utility functions
	 */

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
			off = pack(def,buf,0,args,0);
		return toBuffer(buf.slice(0,off+1));
	}

	function hostReply(def, call) {
		return function(payload) {
			var out = unpack('B' + def, payload);
			if (this.checkError(out[0],RESPONSE_CODE.SUCCESS)) return;
			if (call) call.bind(this)(out.slice(1));
		}
	}

	function toolQuery(tool, cmd) {
		return hostCommand(HOST_QUERY.TOOL_QUERY, 'BB', [tool, cmd]);
	}

	function toolCommand(tool, cmd, def, args) {
		var buf = new ArrayBuffer(256),
			off = pack(def,buf,4,args,0);
		pack('BBBB',buf,0,[HCMD_ID.TOOL_ACTION, tool, cmd, off-4],0);
		return toBuffer(buf.slice(0,off+1));
	}

	/**
	 * @param {String} def
	 * @param {ArrayBuffer} buf
	 * @param {number} off
	 * @param {Array} args
	 * @param {number} argi
	 * @returns {*}
	 */
	function pack(def,buf,off,args,argi) {
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
				case 'f':
					view.setFloat32(off, param, true);
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

	/**
	 * @param {String} def
	 * @param {ArrayBuffer} buf
	 * @returns {Array}
	 */
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
				case 'f':
					out.push(view.getFloat32(off, true));
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

	function checkSuccess(payload) {
		if (payload[0] !== RESPONSE_CODE.SUCCESS) {
			throw exception("request fail", "response code: "+payload[0], payload[0]);
		}
	}

	function exception(name, message, code) {
		return {"name":name, "message":message, code:code};
	}

	/**
	 * @param {Buffer} payload
	 * @param {number} off
	 * @param {number} len
	 * @returns {number}
	 */
	function crcCalc(payload,off,len) {
		if (!payload) throw exception("Argument Exception", 'payload is null or undefined');
		var i = off || 0,
			val = 0,
			max = len || payload.byteLength || payload.length;
		while (i < max) val = CRC_TABLE[val ^ payload[i++]];
		return val;
	}

	function map(arr, k, v) {
		var out = {}, len = arr.length, i = 0;
		while (i < len) out[arr[i][k]] = arr[i++][v];
		return out;
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
		HCMD_DEF = [
			['FIND_AXES_MIN',           131, 'BLI'],      // axes, feedrate(ms), timeout(s)
			['FIND_AXES_MAX',           132, 'BLI'],      // axes, feedrate(ms), timeout(s)
			['DELAY',                   133, 'L'],        // delay(ms)
			['CHANGE_TOOL',             134, 'B'],        // tool_id
			['WAIT_TOOL_READY',         135, 'BII'],      // tool_id, delay(ms), timeout(s)
			['TOOL_ACTION',             136, 'BBB['],      // tool_id, action_id, payload_length, payload
			['AXES_ENABLE_DISABLE',     137, 'B'],        // axes
			['USER_BLOCK',              138, 'I'],        // unused (sailfish)
			['MOVE_TO_EXTENDED_V1',     139, 'lllllL'],   // x_steps, y_steps, z_steps, a_steps, b_steps, ms_feed_rate
			['SET_POSITION_EXTENDED',   140, 'lllll'],    // x_pos, y_pos, z_pos, a_pos, b_pos
			['WAIT_PLATFORM_READY',     141, 'BII'],      // tool_id, delay(ms), timeout(s)
			['MOVE_TO_EXTENDED_V2',     142, 'lllllLB'],  // x_steps, y_steps, z_steps, a_steps, b_steps, duration, bitfield
			['STORE_HOME_POSITIONS',    143, 'B'],        // axes
			['LOAD_HOME_POSITIONS',     144, 'B'],        // axes
			['SET_POTENTIOMETER',       145, 'BB'],       // axis, value
			['SET_RGB_LED',             146, 'BBBBB'],    // red, green, blue, blink_rate, reserved
			['SET_BEEP',                147, 'IIB'],      // frequency, duration(ms), reserved
			['WAIT_FOR_BUTTON',         148, 'BIB'],      // buttons, timeout(s), options
			['DISPLAY_MESSAGE',         149, 'BBBBS'],    // options, hpos, vpos, timeout(s), message
			['SET_BUILD_PERCENT',       150, 'BB'],       // percent, reserved
			['PLAY_SONG',               151, 'B'],        // song_id (0=err1, 1=done, 2=err2)
			['RESET_FACTORY',           152, 'B'],        // reserved
			['BUILD_START',             153, 'LS'],       // reserved, build_name
			['BUILD_END',               154, 'B'],        // reserved
			['MOVE_TO_EXTENDED_V3',     155, 'lllllLBfI'],// x_steps, y_steps, z_steps, a_steps, b_steps, dda_rate...
			['SEGMENT_ACCELERATION',    156, 'B'],        // value (o=off, 1=on)
			['STREAM_VERSION',          157, 'BBBLI']     // ver_high, ver_low, reserved, reserved, bot_type
		],
		HCMD_ID = map(HCMD_DEF, 0, 1),
		HCMD_ENC = map(HCMD_DEF, 0, 2),
		HCMD_DEC = map(HCMD_DEF, 1, 2),
		HCMD_DESC = map(HCMD_DEF, 1, 0),
		TOOL_QUERY = {
			'GET_TOOLHEAD_TEMP'        : 2,
			'GET_PLATFORM_TEMP'        : 30,
			'GET_TOOLHEAD_TARGET_TEMP' : 32,
			'GET_PLATFORM_TARGET_TEMP' : 33
		},
		TOOL_CMD = {
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

