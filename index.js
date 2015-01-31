var MakerLink = require('./makerlink');

function probe(host, port) {
	var link = new MakerLink();
	link.open(host, port);
	link
//		updateBufferFree()
		.updateBuildName()
		.updateBuildStatistics()
		.updateToolheadTemperature(0)
		.updateFileList()
		.updateBusy()
		.updateBufferFree()
		.onReady(function(ml) {
			console.log(ml.state);
		});
}

probe('localhost', 5000);
//probe('localhost', 5001);
//probe('localhost', 5002);
//probe('localhost', 5003);
//probe('localhost', 5004);
