var MakerLink = require('./makerlink');

function probe(host, port) {
	var link = new MakerLink();
	link.open(host, port);
	link
//		.bootInit()
//		.clearBuffer() // causes bot to be unresponsive for a few millis or ignore next command
		.updateBufferFree()
		.updateBuildName()
		.updateBuildStatistics()
		.updateToolheadTemperature(0)
		.updateToolheadTargetTemperature(0)
//		.captureToFile('capture.x3g')
//		.endCapture()
		.updateFileList()
		.updateBusy()
		.updateBufferFree()
		.updateBoardState()
		.updateVersionExt()
		.onReady(function(ml) {
			console.log(ml.state);
		});
}

probe('localhost', 5000);
//probe('localhost', 5001);
//probe('localhost', 5002);
//probe('localhost', 5003);
//probe('localhost', 5004);
