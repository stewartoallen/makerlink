module.exports = (function MakerLinkModule() {
	'use strict';

	var events = require('events'),
		net		= require('net');

	var MakerLink = function() {
		this.conn = new NetConn();
	};

	MakerLink.prototype.reset = function(callback) {
		this.conn.drain();
	};

	MakerLink.prototype.open = function(host, port) {
		this.conn.open(host, port);
	};

	MakerLink.prototype.close = function() {
		this.conn.drain();
	};

	MakerLink.prototype.getBuildName = function(callback) {
		this.conn.once('payload', function(payload) {
			if (payload[0] === CONSTANTS.RESPONSE_CODE.SUCCESS) {
				var name = "";
				for (var i = 1; i < payload.byteLength; i++) {
					if (payload[i] != 0) name = name + String.fromCharCode(payload[i]);
				}
				return callback({buildname:name});
			} 
			callback({error:"invalid buildname payload"});
		});
		this.conn.write(query(CONSTANTS.HOST_QUERY.GET_BUILD_NAME));
	}

	MakerLink.prototype.getToolheadTemperature = function(tool, callback) {
		this.conn.once('payload', function(payload) {
			if (payload[0] === CONSTANTS.RESPONSE_CODE.SUCCESS) {
				var celsius = ((payload[1] | ((payload[2] & 0xFF) << 8)));
				return callback({celcius:celsius});
			}
			callback({error:"invalid tooltemp payload"});
		});
		this.conn.write(
			query(CONSTANTS.HOST_QUERY.TOOL_QUERY, tool, CONSTANTS.TOOL_QUERY.GET_TOOLHEAD_TEMP)
		);
	};

	MakerLink.prototype.getBuildStatistics = function(callback) {
		this.conn.once('payload', function(payload) {
			if (payload[0] === CONSTANTS.RESPONSE_CODE.SUCCESS) {
				var stats = {
					state: "",
					hours: 0,
					minutes: 0
				},
				build_state_consts = CONSTANTS.BUILD_STATE;
				for (var state in build_state_consts) {
					if (build_state_consts.hasOwnProperty(state)) {
						if (build_state_consts[state] === payload[1]) {
							stats.state = CONSTANTS.BUILD_STATE_DESC[state];
							break;
						}
					}
				}
				stats.hours = payload[2];
				stats.minutes = payload[3];
				return callback(stats);
			}
			callback({error:"invalid tooltemp payload"});
		});
		this.conn.write(query(CONSTANTS.HOST_QUERY.GET_BUILD_STATS));
	};

	// wrap tcp connection

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
		try {
			for (var i = 0; i < data.length; ++i) {
				this.decoder.parseByte(data[i]);
				if (this.decoder.isPayloadReady()) {
					var payload = this.decoder.payload;
					this.decoder.reset();
					this.emit('payload', payload);
				}
			}
		} catch (err) {
			console.log({process_error:err});
			this.decoder.reset();
			this.emit('error', err);
		}
	};

	NetConn.prototype.write = function(data) {
		if (!this.client) throw "not connected";

		this.drain = false;

		if (this.buffer) {
			this.buffer.push(data);
		} else {
			this.client.write(data);
		}
	};

	var CONSTANTS = {
		PROTOCOL_STARTBYTE		: 0xD5,
		MAX_PAYLOAD_LENGTH		: 32,
		HOST_QUERY : {
			'TOOL_QUERY'		: 10,
			'GET_BUILD_NAME'	: 20,
			'GET_BUILD_STATS'	: 24
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
			'NO_BUILD_INITIALIZED'		: 0x00,
			'BUILD_RUNNING'				: 0x01,
			'BUILD_FINISHED_NORMALLY'	: 0x02,
			'BUILD_PAUSED'				: 0x03,
			'BUILD_CANCELLED'			: 0x04,
			'BUILD_SLEEPING'			: 0x05
		},
		BUILD_STATE_DESC: {
			'NO_BUILD_INITIALIZED'		: "Idle",
			'BUILD_RUNNING'				: "Build Running",
			'BUILD_FINISHED_NORMALLY'	: "Build Complete",
			'BUILD_PAUSED'				: "Build Paused",
			'BUILD_CANCELLED'			: "Build Cancelled",
			'BUILD_SLEEPING'			: "No Build Active"
		}
	};

	/**
	 * CRC table from http://forum.sparkfun.com/viewtopic.php?p=51145
	 */
	var _crctab = [
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

	var _exception = function ExceptionCreator(name, message) {
		return {"name":name, "message":message};
	}

	/**
	* Calculate 8-bit [iButton/Maxim CRC][http://www.maxim-ic.com/app-notes/index.mvp/id/27] of the payload
	* @method CRC
	* @param {ArrayBuffer} payload
	* @return {uint8} Returns crc value on success, throws exceptions on failure
	*/
	var CRC = function CRC(payload) {
		if (!payload) {
			throw _exception("Argument Exception", 'payload is null or undefined');
		} else if (!(payload instanceof ArrayBuffer)) {
			throw _exception("Argument Exception", 'payload is not an ArrayBuffer');
		}
		var crc = 0;
		for(var i = 0; i < payload.byteLength; ++i) {
			crc = _crctab[crc ^ payload[i]];
		}
		return crc;
	};

	/**
	* Create protocol message from ArrayBuffer
	*
	* @method encode
	* @param {ArrayBuffer} payload Single Payload of s3g Protocol Message
	* @return {ArrayBuffer} Returns packet on success, throws exceptions on failure
	*/
	var encode = function Encode(payload) {
		if (!payload) {
			throw _exception("Argument Exception", 'payload is null or undefined');
		} else if (!(payload instanceof ArrayBuffer)) {
			throw _exception("Argument Exception", 'payload is not an ArrayBuffer');
		} else if (payload.byteLength > CONSTANTS.MAX_PAYLOAD_LENGTH) {
			throw _exception("Packet Length Exception", 'payload length (' + payload.byteLength + ') is greater than max ('+ CONSTANTS.MAX_PAYLOAD_LENGTH + ').');
		}

		// Create Packet
		var len = payload.byteLength,
		packet = new DataView(new ArrayBuffer(len + 3 /* Protocol Bytes */));
		packet.setUint8(0, CONSTANTS.PROTOCOL_STARTBYTE);
		packet.setUint8(1, len);

		for(var i = 0, offset = 2; i < payload.byteLength; ++i, ++offset) {
			packet.setUint8(offset, payload[i]);
		}
		packet.setUint8(len + 2, CRC(payload));
		return packet;
	};

	var PACKETSTATES = {
		WAIT_FOR_HEADER: 0,
		WAIT_FOR_LENGTH: 1,
		WAIT_FOR_DATA: 2,
		WAIT_FOR_CRC: 3,
		PAYLOAD_READY: 4
	};

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
		switch(this.state) {
			case PACKETSTATES.WAIT_FOR_HEADER:
				if (_byte !== CONSTANTS.PROTOCOL_STARTBYTE) {
					throw _exception('Packet Header Exception', 'packet header value incorrect('+_byte+')');
				}
				this.state = PACKETSTATES.WAIT_FOR_LENGTH;
				break;
			
			case PACKETSTATES.WAIT_FOR_LENGTH:
				if (_byte > CONSTANTS.MAX_PAYLOAD_LENGTH) {
					throw _exception('Packet Length Exception', 'packet length ('+ _byte +') value greater than max.');
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
					throw _exception('Packet Length Exception', 'packet length incorrect.');
				} else if (this.payloadOffset === this.expectedLength) {
					this.state = PACKETSTATES.WAIT_FOR_CRC;
				}
				break;
			case PACKETSTATES.WAIT_FOR_CRC:
				var crc = CRC(this.payload);
				if (crc !== _byte){
					throw _exception('Packet CRC Exception', 'packet crc incorrect.');
				}
				this.state = PACKETSTATES.PAYLOAD_READY;
				break;
			default:
				throw _exception('Parser Exception', 'default state reached.');
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

	var query = function BuildQuery() {
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

	return MakerLink;

})();

