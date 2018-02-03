var MakerLink = require('./makerlink');

function probe(link) {
    link
        //.endCapture()
        //.bootInit()
        //.jobAbort()
        //.resetBot() // causes bot to be unresponsive for a few millis or ignore next command
        //.clearBuffer() // causes bot to be unresponsive for a few millis or ignore next command

        .requestBusyState()
        .requestBufferFree()
        .requestBuildName()
        .requestBuildStatistics()

        .setToolheadTemperature(0,100)
        .requestToolheadTemperature(0)
        .requestToolheadTargetTemperature(0)

        //.captureToFile('capture3.x3g')
        //.setToolheadTemperature(0,100)
        //.setToolheadTemperature(0,0)
        //.endCapture()

        //.requestFileList() // kills a running print job
        .requestBufferFree()
        .requestBoardState()
        .requestVersionExt()

        .onReady(function(ml) {
            console.log(ml.state);
//            link.resetBot()
        });
}

function storeToSD(link, src, dst) {
    link
        .requestBusyState()
        .requestBufferFree()
        .captureToFile(dst)
        .sendFile(src)
        .onReady(function(ml) {
            console.log(ml.state);
            link.endCapture().onReady(function(mk) {
                console.log(mk.state);
            });
        });
}

function playFromSD(link, file) {
    link
        .requestBufferFree()
        .requestToolheadTemperature(0)
        .playbackFile(file)
        .onReady(function(ml) {
            console.log(ml.state);
            link.jobAbort()
        });
}

function read(filename) {
    var link = new MakerLink();
    link.readFile(filename);
}

function foundPrinter(link) {
    probe(link);
    //print(link, 'mik torus.x3g');
    //read('../../python/cube.x3g');
    //read(process.argv[2]);
    //storeToSD(link, process.argv[2], process.argv[3]);
}

require('serialport').list( (err, ports) => {
    ports.forEach(port => {
        if (port.manufacturer == 'MakerBot Industries' && port.productId == 'The Replicator') {
            console.log({found: port});
            foundPrinter(new MakerLink().openSerial(port.comName));
        }
    })
});
