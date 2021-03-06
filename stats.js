versionstring = "statsd-librato/1.1"

var dgram      = require('dgram')
  , sys        = require('util')
  , net        = require('net')
  , config     = require('./config')
  , underscore = require('underscore')
  , async      = require('async')
  , https      = require('https')
  , crypto     = require('crypto')
  , syslog     = require('node-syslog');

syslog.init("node-syslog", syslog.LOG_PID | syslog.LOG_ODELAY, syslog.LOG_LOCAL0);

var counters = {};
var timers = {};
var debugInt, flushInt, server, mgmtServer;
var startup_time = Math.round(new Date().getTime() / 1000);

var globalstats = {
  graphite: {
    last_flush: startup_time,
    last_exception: startup_time
  },
  messages: {
    last_msg_seen: startup_time,
    bad_lines_seen: 0,
	bad_signature_seen: 0
  }
};

process.on('uncaughtException', function (err) {
  syslog.log(syslog.LOG_ERR, 'Caught exception: ' + err);
});

config.configFile(process.argv[2], function (config, oldConfig) {
  function graphServiceIs(name){
    return (config.graphService) && (config.graphService == name);
  }

  if (!config.debug && debugInt) {
    clearInterval(debugInt); 
    debugInt = false;
  }

  if (config.debug) {
    if (debugInt !== undefined) { clearInterval(debugInt); }
    debugInt = setInterval(function () { 
      syslog.log(syslog.LOG_INFO, "Counters:\n" + sys.inspect(counters) + "\nTimers:\n" + sys.inspect(timers));
    }, config.debugInterval || 10000);
  }

  if (server === undefined) {
    server = dgram.createSocket('udp4', function (msg, rinfo) {
      var msgStr = msg.toString().replace(/^\s+|\s+$/g,"").replace(/\u0000/g, '');
      if (msgStr.length == 0) {
        if (config.debug) {
          syslog.log(syslog.LOG_DEBUG, 'No messsages.');
        }
        return;
      }
      if (config.dumpMessages) {
        syslog.log(syslog.LOG_INFO, 'Messages: ' + msgStr);
      }
      var bits = msgStr.split(':');
      var key = '';
      if (graphServiceIs("librato-metrics")){
        key = bits.shift().replace(/[^-.:_\w]+/, '_').substr(0,255)
      } else {
        key = bits.shift()
                  .replace(/\s+/g, '_')
                  .replace(/\//g, '-')
                  .replace(/[^a-zA-Z_\-0-9\.]/g, '');
      }

      if (bits.length == 0) {
        return;
      }
	  // split the received message in fields and handle it
      for (var i = 0; i < bits.length; i++) {
        var sampleRate = 1;
        var fields = bits[i].split("|");
        if (fields[1] === undefined) {
            syslog.log(syslog.LOG_ERR, 'Bad line: ' + fields);
            globalstats['messages']['bad_lines_seen']++;
            continue;
        }
		
		// signed messages have the format 
		// stat:delta|type[|@sample_rate][|nonce|signature]
		if (config.signMessages) {
			var signature = fields.pop();
			var nonce = fields.pop();
			var signstring = msgStr.replace("|" + signature, "")
			
			if (nonce === undefined || signature === undefined || (signature != crypto.createHmac("md5", config.tokenSecret).update(signstring, "utf8").digest("hex"))) {
            	if (config.logSignatureErrors) {
					syslog.log(syslog.LOG_ERR, 'Bad signature: ' + signature + ' for fields ' + fields + ". Dropping message.");
				}
            	globalstats['messages']['bad_signature_seen']++;
            	continue;
			}
		}
		
		
        if (fields[1].trim() == "ms") {
          if (! timers[key]) {
            timers[key] = [];
          }
          timers[key].push(Number(fields[0] || 0));
        } else {
          if (fields[2] && fields[2].match(/^@([\d\.]+)/)) {
            sampleRate = Number(fields[2].match(/^@([\d\.]+)/)[1]);
          }
          if (! counters[key]) {
            counters[key] = 0;
          }
          counters[key] += Number(fields[0] || 1) * (1 / sampleRate);
        }
      }

      globalstats['messages']['last_msg_seen'] = Math.round(new Date().getTime() / 1000);
    });

    server.on("listening", function () {
      var address = server.address();
      syslog.log(syslog.LOG_INFO, "statsd is running on " + address.address + ":" + address.port);
    });

    mgmtServer = net.createServer(function(stream) {
      stream.setEncoding('ascii');

      stream.on('data', function(data) {
        var cmd = data.trim();

        switch(cmd) {
          case "help":
            stream.write("Commands: stats, counters, timers, quit\n\n");
            break;

          case "stats":
            var now    = Math.round(new Date().getTime() / 1000);
            var uptime = now - startup_time;

            stream.write("uptime: " + uptime + "\n");

            for (group in globalstats) {
              for (metric in globalstats[group]) {
                var val;

                if (metric.match("^last_")) {
                  val = now - globalstats[group][metric];
                }
                else {
                  val = globalstats[group][metric];
                }

                stream.write(group + "." + metric + ": " + val + "\n");
              }
            }
            stream.write("END\n\n");
            break;

          case "counters":
            stream.write(sys.inspect(counters) + "\n");
            stream.write("END\n\n");
            break;

          case "timers":
            stream.write(sys.inspect(timers) + "\n");
            stream.write("END\n\n");
            break;

          case "quit":
            stream.end();
            break;

          default:
            stream.write("ERROR\n");
            break;
        }

      });
    });

    server.bind(config.port || 8125);
    mgmtServer.listen(config.mgmt_port || 8126);

    sys.log("server is up");

    var flushInterval = Number(config.flushInterval || 10000);

    flushInt = setInterval(function () {
      var stats = {};
      stats["gauges"] = {};
      stats["counters"] = {};
      var ts = Math.round(new Date().getTime() / 1000);
      var numStats = 0;
      var key;

      for (key in counters) {
        var stat;
        if (graphServiceIs("librato-metrics")){
          stat = stats["gauges"];
        } else {
          stat = stats["counters"];
        }

        var value = counters[key] / (flushInterval / 1000);
        stat[key] = {};
        stat[key]["value"] = value;

        counters[key] = 0;

        numStats += 1;
      }

      for (key in timers) {
        if (timers[key].length > 0) {
          var pctThreshold = config.percentThreshold || 90;
          var values = timers[key].sort(function (a,b) { return a-b; });
          var count = values.length;
          var min = values[0];
          var max = values[count - 1];

          var mean = min;
          var maxAtThreshold = max;

          if (count > 1) {
            var thresholdIndex = Math.round(((100 - pctThreshold) / 100) * count);
            var numInThreshold = count - thresholdIndex;
            values_sliced = values.slice(0, numInThreshold);
            maxAtThreshold = values_sliced[numInThreshold - 1];
            // average the remaining timings
            var sum = 0;
            for (var i = 0; i < numInThreshold; i++) {
              sum += values_sliced[i];
            }
            mean = sum / numInThreshold;
          }

          var sum = 0;
          var sumOfSquares = 0;
          for (var i = 0; i < count; i++) {
            sum += values[i];
            sumOfSquares += values[i] * values[i];
          }

          timers[key] = [];
          stats["gauges"][key] = {};
          stats["gauges"][key]["count"] = count;
          stats["gauges"][key]["sum"] = sum;
          stats["gauges"][key]["sum_squares"] = sumOfSquares;
          stats["gauges"][key]["min"] = min;
          stats["gauges"][key]["max"] = max;
          if (!graphServiceIs("librato-metrics")){
            stats["gauges"][key]["upper_" + pctThreshold] = maxAtThreshold;
            stats["gauges"][key]["mean"] = mean;
          }

          numStats += 1;
        }
      }

      if (graphServiceIs("librato-metrics")){
        stats["gauges"]["numStats"] = {};
        stats["gauges"]["numStats"]["value"] = numStats;
      } else {
        stats["counters"]["numStats"] = {};
        stats["counters"]["numStats"]["value"] = numStats;
      }

      var slicey = function(obj,slicelen){
        var slicecounter = 0;
        var groups = underscore.groupBy(obj,function (num){ var ret = Math.floor(slicecounter/slicelen); slicecounter += + 1; return ret;});
        return underscore.map(groups,function(k,v){ return k; });
      }

      function build_hash(type){
        return function(group){
          var hash = {};
          hash[type] = {};
          underscore.each(group,function(metric){
            hash[type][metric] = stats[type][metric];
          });
          if (graphServiceIs("librato-metrics")){
            hash["measure_time"] = ts
            if (config.libratoSource) { hash["source"] = config.libratoSource; }
          }
          return hash;
        };
      }

      function build_string(type){
        return function(stats){
          var stats_str ='';

          if (graphServiceIs("librato-metrics")){
            stats_str = JSON.stringify(stats);
          } else {
            for (k in stats[type]){
              var stat = stats[type][k];
              if (type == "counters"){
                var per_interval_value = stat["value"] / (flushInterval / 1000);
                stats_str += ('stats.' + k + ' ' + per_interval_value + ' ' + ts + "\n");
                stats_str += ('stats_counts.' + k + ' ' + stat["value"] + ' ' + ts + "\n");
              } else {
                for (s in stat){
                  stats_str += ('stats.timers.' + k + '.' + s + ' ' + stat[s] + ' ' + ts + "\n");
                }
              }
            }
          }
          return stats_str;
        };
      }

      var slice_length = config.batch || 200;
      var ggroups = slicey(underscore.keys(stats["gauges"]),slice_length);
      var cgroups = slicey(underscore.keys(stats["counters"]),slice_length);
      var ghashes = underscore.map(ggroups,build_hash("gauges"));
      var chashes = underscore.map(cgroups,build_hash("counters"));

      var lengths = underscore.map(ggroups.concat(cgroups),function (m){ return m.length; });
      var chunks = underscore.map(ggroups.concat(cgroups),function (m){ return m.join(); });

      var gstrs = underscore.map(ghashes,build_string("gauges"));
      var cstrs = underscore.map(chashes,build_string("counters"));

      var strings = gstrs.concat(cstrs);

      async.forEach(strings,function(stats_str,cb){
        if (config.debug) {
          syslog.log(syslog.LOG_DEBUG, stats_str);
          syslog.log(syslog.LOG_DEBUG, stats_str.length);
        }

        if (graphServiceIs("librato-metrics")){
          var submit_to_librato = function(stats_str,retry){
            var options = {
              host: 'metrics-api.librato.com',
              port: 443,
              path: '/v1/metrics.json',
              method: 'POST',
              headers: {
                "Authorization": 'Basic ' + new Buffer(config.libratoUser + ':' + config.libratoApiKey).toString('base64'),
                "Content-Length": stats_str.length,
                "Content-Type": "application/json",
                "User-Agent" : versionstring
              }
            };

            var req = https.request(options, function(res) {
              if(res.statusCode != 204){
                res.on('data', function(d){
                  var errdata = "HTTP " + res.statusCode + ": " + d;
                  if (retry){
                    setTimeout(function(){
                      submit_to_librato(stats_str,false);
                    }, Math.floor(flushInterval/2) + 100);
                  } else {
                    syslog.log(syslog.LOG_CRIT, "Error connecting to Librato!\n" + errdata);
                  }
                });
              }
            });
            req.write(stats_str);
            req.end();
            globalstats['graphite']['last_flush'] = Math.round(new Date().getTime() / 1000);
            req.on('error', function(errdata) {
                if (retry){
                  setTimeout(function(){
                    submit_to_librato(stats_str,false);
                  }, Math.floor(flushInterval/2) + 100);
                } else {
                  syslog.log(syslog.LOG_CRIT, "Error connecting to Librato!\n" + errdata);
                }
            });
          }

          submit_to_librato(stats_str,true);
        } else {
          if (config.graphiteHost) {
            try {
              var graphite = net.createConnection(config.graphitePort, config.graphiteHost);
              graphite.addListener('error', function(connectionException){
                  if (config.debug) {
                    syslog.log(syslog.LOG_CRIT, connectionException);
                  }
              });
              graphite.on('connect', function() {
                  this.write(stats_str);
                  this.end();
                  globalstats['graphite']['last_flush'] = Math.round(new Date().getTime() / 1000);
                  });
            } catch(e){
              if (config.debug) {
                syslog.log(syslog.LOG_DEBUG, e);
              }
            }
          }
        }
        cb(null,null);
      }, function(e){
        if (e){
          globalstats['graphite']['last_exception'] = Math.round(new Date().getTime() / 1000);
          if(config.debug) {
            syslog.log(syslog.LOG_DEBUG, e);
          }
        }
      });
    }, flushInterval);
  }
});

