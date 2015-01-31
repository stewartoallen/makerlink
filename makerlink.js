module.exports = (function MakerLinkModule() {

	'use strict';

	var events = require('events'),
		net	   = require('net'),
		maxQ   = 1,
		ncWait = 10;

	var MakerLink = function() {
		this.conn = new NetConn();

		this.conn.on('payload', function(payload) {
			//console.log({payload:payload});
			var q = this.queue,
				fn = q.splice(0,1)[0];
			if (fn) fn(payload);
			this.callOnReady();
		}.bind(this));

		this.conn.on('error', function(error) {
			// todo flush til next cmd object and call it w/ error
			console.log({error:error});
			this.errors.push(error);
		}.bind(this));

		this.state = {
			build:{
				name:null,
				state:null,
				hours:0,
				minutes:0
			},
			tool:[{},{},{},{}],
			sdcard:[],
			buffer:0,
			busy:false
		};

		this.queue = [];
		this.queueOut = [];
		this.errors = [];
		this.onReadyQ = [];
	};

	var MLP = MakerLink.prototype;

	MLP.test = function() {
		var p = pack('BiIlLS', 1, 2, 3, 4, 5, "Stewart");
		var u = unpack('BiIlLS', p);
		console.log({p:p, u:u});
	};

	MLP.resetComms = function(callback) {
		this.conn.drain();
		this.queue = [];
		this.callOnReady();
	};

	MLP.open = function(host, port) {
		this.conn.open(host, port);
		//this.clearBuffer();
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

	MLP.queueCommand = function(packet, callback) {
		this.queueOut.push({packet:packet, callback:callback});
		this.checkQueueOut();
	};

	MLP.checkQueueOut = function() {
		while (this.queueOut.length > 0 && this.queue.length < maxQ) {
			var next = this.queueOut.splice(0,1)[0];
			if (next.callback) {
				this.queue.push(next.callback);
			} else {
				setTimeout(this.processNextCommand, ncWait);
			}
			this.conn.write(next.packet);
		}
	};

	/** HOST COMMANDS */

	/**
	 * docs say this has no return, but it seems to
	 * and the bot will drop serial traffic for a few
	 * milliseconds after this command is ACKd.
	 */
	MLP.clearBuffer = function() {
		this.queueCommand(
			query(CONST.HOST_QUERY.CLEAR_BUFFER),
			function(payload) {
				console.log({clear_payload:payload});
			}.bind(this)
		);
		return this;
	}

	MLP.updateBufferFree = function() {
		this.queueCommand(
			query(CONST.HOST_QUERY.GET_BUFFER_FREE),
			function(payload) {
				var out = unpack('BL', payload);
				if (this.checkError(out[0],CONST.RESPONSE_CODE.SUCCESS)) return;
				this.state.buffer = out[1];
			}.bind(this)
		);
		return this;
	}

	MLP.resetBot = function() {
		this.queueCommand(query(CONST.HOST_QUERY.RESET));
		return this;
	}

	MLP.jobAbort = function() {
		this.queueCommand(query(CONST.HOST_QUERY.JOB_ABORT));
		return this;
	}

	MLP.jobPauseResume = function() {
		this.queueCommand(query(CONST.HOST_QUERY.JOB_PAUSE_RESUME));
		return this;
	}

	/** check if bot is busy with commands in queue */
	MLP.updateBusy = function() {
		this.queueCommand(
			query(CONST.HOST_QUERY.CHECK_BUSY),
			function(payload) {
				if (this.checkError(payload[0],CONST.RESPONSE_CODE.SUCCESS)) return;
				this.state.busy = payload[1] === 0;
			}.bind(this)
		);
		return this;
	}

	MLP.updateBuildName = function() {
		this.queueCommand(
			query(CONST.HOST_QUERY.GET_BUILD_NAME),
			function(payload) {
				if (this.checkError(payload[0],CONST.RESPONSE_CODE.SUCCESS)) return;
				this.state.build.name = decodeString(payload, 1);
			}.bind(this)
		);
		return this;
	}

	MLP.updateBuildStatistics = function() {
		this.queueCommand(
			query(CONST.HOST_QUERY.GET_BUILD_STATS),
			function(payload) {
				if (this.checkError(payload[0],CONST.RESPONSE_CODE.SUCCESS)) return;
				this.state.build.state = CONST.BUILD_STATE[payload[1]];
				this.state.build.hours = payload[2];
				this.state.build.minutes = payload[3];
			}.bind(this)
		);
		return this;
	};

	MLP.updateFileList = function(more) {
		this.queueCommand(
			query(CONST.HOST_QUERY.GET_NEXT_FILENAME, more ? 0 : 1),
			function(payload) {
				if (this.checkError(payload[0],CONST.RESPONSE_CODE.SUCCESS)) return;
				var sd_rc = payload[1], // what is SD response code for? always zero?
					file = decodeString(payload, 2);
				if (!more) this.state.sdcard = [];
				if (file && file != '') {
					this.updateFileList(true);
					this.state.sdcard.push(file);
				}
			}.bind(this)
		);
		return this;
	};

	/** TOOL COMMANDS */

	MLP.updateToolheadTemperature = function(tool) {
		this.queueCommand(
			query(CONST.HOST_QUERY.TOOL_QUERY, tool, CONST.TOOL_QUERY.GET_TOOLHEAD_TEMP),
			function(payload) {
				if (this.checkError(payload[0],CONST.RESPONSE_CODE.SUCCESS)) return;
				var celsius = ((payload[1] | ((payload[2] & 0xFF) << 8)));
				this.state.tool[tool].temp = celsius;
			}.bind(this)
		);
		return this;
	};

	/**
	 * Wrap TCP conection
	 */
	function NetConn() {
		this.decoder = null;
		this.client = null;
		this.buffer = [];
		this.drain = true;
	}

	NetConn.prototype = Object.create(events.EventEmitter.prototype);

	NetConn.prototype.open = function(host,port) {
		if (this.client) throw "already connected";

		this.decoder = new PacketStreamDecoder();
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
			this.decoder = null;
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
				this.decoder.parseByte(data[i]);
				if (this.decoder.isPayloadReady()) {
					var payload = this.decoder.payload;
					this.decoder.reset();
					this.emit('payload', payload);
				}
			}
		} catch (err) {
			this.decoder.reset();
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
	 * CONST
	 */

	var CONST = {
		PROTOCOL_STARTBYTE		: 0xD5,
		MAX_PAYLOAD_LENGTH		: 32,
		HOST_QUERY : {
			'GET_BUFFER_FREE'	: 2,
			'CLEAR_BUFFER'		: 3,
			'JOB_ABORT'			: 7,
			'JOB_PAUSE_RESUME'	: 8,
			'TOOL_QUERY'		: 10,
			'CHECK_BUSY'		: 11,
			'GET_BUILD_NAME'	: 20,
			'GET_BUILD_STATS'	: 24,
			'CAPTURE_TO_FILE'	: 14,
			'END_CAPTURE'		: 15,
			'PLAY_CAPTURE'		: 16,
			'RESET'				: 17,
			'GET_NEXT_FILENAME'	: 18
		},
		TOOL_QUERY : {
			'GET_TOOLHEAD_TEMP'			: 2,
			'GET_TOOLHEAD_TARGET_TEMP'	: 32
		},
		RESPONSE_CODE : {
			'GENERIC_PACKET_ERROR'	: 0x80,
			'SUCCESS'				: 0x81,
			'ACTION_BUFFER_OVERFLOW': 0x82,
			'CRC_MISMATCH'			: 0x83,
			'COMMAND_NOT_SUPPORTED' : 0x85,
			'DOWNSTREAM_TIMEOUT'	: 0x87,
			'TOOL_LOCK_TIMEOUT'		: 0x88,
			'CANCEL_BUILD'			: 0x89,
			'ACTIVE_LOCAL_BUILD'	: 0x8A,
			'OVERHEAT_STATE'		: 0x8B,
		},
		BUILD_STATE: {
			'0' : "Idle",
			'1' : "Running",
			'2' : "Complete",
			'3' : "Paused",
			'4' : "Cancelled",
			'5' : "None Active"
		}
	};

	/**
	 * CRC table from http://forum.sparkfun.com/viewtopic.php?p=51145
	 */
	var CRC_TABLE = [
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
	];

	function exception(name, message) {
		return {"name":name, "message":message};
	}

	/**
	* Calculate 8-bit [iButton/Maxim CRC][http://www.maxim-ic.com/app-notes/index.mvp/id/27] of the payload
	* @method CRC
	* @param {ArrayBuffer} payload
	* @return {uint8} Returns crc value on success, throws exceptions on failure
	*/
	function CRC(payload) {
		if (!payload) {
			throw exception("Argument Exception", 'payload is null or undefined');
		} else if (!(payload instanceof ArrayBuffer)) {
			throw exception("Argument Exception", 'payload is not an ArrayBuffer');
		}
		var crc = 0;
		for(var i = 0; i < payload.byteLength; ++i) {
			crc = CRC_TABLE[crc ^ payload[i]];
		}
		return crc;
	};

	/*
	function packCRC(buf) {
		if (!buf) {
			throw exception("Argument Exception", 'payload is null or undefined');
		} else if (!(buf instanceof ArrayBuffer)) {
			throw exception("Argument Exception", 'payload is not an ArrayBuffer');
		}
		var crc = 0, i = 0;
		while (i < buf.byteLength - 1) {
			crc = CRC_TABLE[crc ^ buf[i++]];
		}
		buf[i] = crc;
		return buf;
	};
	*/

	var PACKETSTATES = {
		WAIT_FOR_HEADER: 0,
		WAIT_FOR_LENGTH: 1,
		WAIT_FOR_DATA: 2,
		WAIT_FOR_CRC: 3,
		PAYLOAD_READY: 4
	};

	/**
	 * Read protocol stream and create packets
	 */

	function PacketStreamDecoder() {
		this.state = PACKETSTATES.WAIT_FOR_HEADER;
		this.payload = undefined;
		this.payloadOffset = 0;
		this.expectedLength = 0;
	}

	/**
	 * Re-construct Packet one byte at a time
	 * @param _byte Byte to add to the stream
	 */
	PacketStreamDecoder.prototype.parseByte = function (_byte) {
		switch (this.state) {
			case PACKETSTATES.WAIT_FOR_HEADER:
				if (_byte !== CONST.PROTOCOL_STARTBYTE) {
					throw exception('Packet Header Exception', 'packet header value incorrect('+_byte+')');
				}
				this.state = PACKETSTATES.WAIT_FOR_LENGTH;
				break;
			
			case PACKETSTATES.WAIT_FOR_LENGTH:
				if (_byte > CONST.MAX_PAYLOAD_LENGTH) {
					throw exception('Packet Length Exception', 'packet length ('+ _byte +') value greater than max.');
				}
				this.expectedLength = _byte;
				this.state = PACKETSTATES.WAIT_FOR_DATA;
				break;

			case PACKETSTATES.WAIT_FOR_DATA:
				if (!this.payload) {
					this.payload = new ArrayBuffer(this.expectedLength);
				}
				this.payload[this.payloadOffset] = _byte;
				++this.payloadOffset;
				if (this.payloadOffset > this.expectedLength) {
					throw exception('Packet Length Exception', 'packet length incorrect.');
				} else if (this.payloadOffset === this.expectedLength) {
					this.state = PACKETSTATES.WAIT_FOR_CRC;
				}
				break;
			case PACKETSTATES.WAIT_FOR_CRC:
				var crc = CRC(this.payload);
				if (crc !== _byte){
					throw exception('Packet CRC Exception', 'packet crc incorrect.');
				}
				this.state = PACKETSTATES.PAYLOAD_READY;
				break;
			default:
				throw exception('Parser Exception', 'default state reached.');
		}
	};

	PacketStreamDecoder.prototype.reset = function() {
		this.state = PACKETSTATES.WAIT_FOR_HEADER;
		this.payload = undefined;
		this.payloadOffset = 0;
		this.expectedLength = 0;
	};

	PacketStreamDecoder.prototype.isPayloadReady = function() {
		return this.state === PACKETSTATES.PAYLOAD_READY;
	};

	/**
	 * Protocol utility functions
	 */

	function encodeString(string) {
		// todo return byte array with null terminated string
	}

	function decodeString(payload, offset) {
		var str = "";
		for (var i = offset; i < payload.byteLength; i++) {
			if (payload[i] === 0) break;
			str = str + String.fromCharCode(payload[i]);
		}
		return str;
	}

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
	};

	function pack(def) {
		var i = 1,
			j = 0,
			off = 0,
			arg = arguments,
			len = arg.length,
			out = new ArrayBuffer(256),
			view = new DataView(out);
		while (i < len) {
			var param = arg[i++];
			switch (def[j++]) {
				case 'B':
					view.setUint8(off++, param);
					break;
				case 'i':
					view.setInt16(off, param);
					off += 2;
					break;
				case 'I':
					view.setUint16(off, param);
					off += 2;
					break;
				case 'l':
					view.setInt32(off, param);
					off += 4;
					break;
				case 'L':
					view.setUint32(off, param);
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
		return out.slice(0,off);
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
					out.push(view.getInt16(off));
					off += 2;
					break;
				case 'I':
					out.push(view.getUint16(off));
					off += 2;
					break;
				case 'l':
					out.push(view.getInt32(off));
					off += 4;
					break;
				case 'L':
					out.push(view.getUint32(off));
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

	/**
	* Create protocol message from ArrayBuffer
	*
	* @method encode
	* @param {ArrayBuffer} payload Single Payload of s3g Protocol Message
	* @return {ArrayBuffer} Returns packet on success, throws exceptions on failure
	*/
	function encode(payload) {
		if (!payload) {
			throw exception("Argument Exception", 'payload is null or undefined');
		} else if (!(payload instanceof ArrayBuffer)) {
			throw exception("Argument Exception", 'payload is not an ArrayBuffer');
		} else if (payload.byteLength > CONST.MAX_PAYLOAD_LENGTH) {
			throw exception("Packet Length Exception", 'payload length (' + payload.byteLength + ') is greater than max ('+ CONST.MAX_PAYLOAD_LENGTH + ').');
		}

		// Create Packet
		var len = payload.byteLength,
		packet = new DataView(new ArrayBuffer(len + 3 /* Protocol Bytes */));
		packet.setUint8(0, CONST.PROTOCOL_STARTBYTE);
		packet.setUint8(1, len);

		for (var i = 0, offset = 2; i < payload.byteLength; ++i, ++offset) {
			packet.setUint8(offset, payload[i]);
		}

		packet.setUint8(len + 2, CRC(payload));
		return packet;
	};

	return MakerLink;

})();

