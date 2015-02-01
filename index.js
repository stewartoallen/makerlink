var MakerLink = require('./makerlink');

function probe(host, port) {
	var link = new MakerLink();
	link.open(host, port);
	link
//		.bootInit()
//		.clearBuffer() // causes bot to be unresponsive for a few millis or ignore next command

		.requestBufferFree()
		.requestBuildName()
		.requestBuildStatistics()
		/*
		*/

//		.setToolheadTemperature(0,0)
		.requestToolheadTemperature(0)
		.requestToolheadTargetTemperature(0)
		/*
		*/

		/*
		.captureToFile('capture.x3g')
		.endCapture()
		*/

		.requestFileList()
		.requestBusyState()
		.requestBufferFree()
		.requestBoardState()
		.requestVersionExt()
		/*
		*/

//		.jobAbort()
		.onReady(function(ml) {
			console.log(ml.state);
		});
}

function print(host, port, file) {
	var link = new MakerLink();
	link
		.open(host, port)
		.requestBufferFree()
		.requestToolheadTemperature(0)
		.playbackFile(file)
		.onReady(function(ml) {
			console.log(ml.state);
		});
}

//probe('localhost', 5000);
//probe('localhost', 5001);
//probe('localhost', 5002); 
//probe('localhost', 5003); 
probe('localhost', 5004);

//print('localhost', 5004, 'mik torus.x3g');
