var MakerLink = require('./makerlink');

function probe(host, port) {
	var link = new MakerLink();
	var info = {port: port};
	link.open(host, port);
	link.getBuildName(function(build) {
		info.build = build;
		//console.log({port:port, build:build});
		link.getToolheadTemperature(0, function(temp) {
			info.temp = temp;
			//console.log({port:port, temp:temp});
			link.getBuildStatistics(function(stat) {
				info.stat = stat;
				console.log(info);
			});
		});
	});
}

probe('localhost', 5000);
probe('localhost', 5001);
probe('localhost', 5002);
probe('localhost', 5003);
probe('localhost', 5004);
