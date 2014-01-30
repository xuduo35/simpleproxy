var net = require('net');
var serverip = "127.0.0.1";
var serverport = 8893;
var connectproxy = 0;
var standalone = 0;

function usage() {
    console.log("usage:");
    console.log("\tnode testproxy.js standalone");
    console.log("\tnode testproxy.js (localhost|remoteIP)");
    console.log("\tnode testproxy.js proxy");
}

if ((process.argv.length < 3) || (process.argv[2] == "--help")) {
    usage();
    return;
}

if (process.argv[2] == "standalone") {
    standalone = 1;
} else if (process.argv[2] == "localhost") {
    connectproxy = 1;
} else if (/^\d+\.\d+\.\d+\.\d+$/.test(process.argv[2])) {
    connectproxy = 1;
    serverip = process.argv[2];
} else if (process.argv[2] == "proxy") {
    serverport += 1;
} else {
    usage();
    return;
}

function encrypt(data) {
    for (var i = 0; i < data.length; i++) {
        data[i] += -1;
    }

    return data;
}

function decrypt(data) {
    for (var i = 0; i < data.length; i++) {
        data[i] -= -1;
    }

    return data;
}

function startService(client, options, cryptfuncs, connopts) {
        //建立到目标服务器的连接
        var server =  net.createConnection(options);
        var client_closeflag = 0;
        var server_closeflag = 0;

        client.pause();
        server.pause();

        //交换服务器与浏览器的数据
        client.on("data", function (data) {
            if (!server_closeflag) {
                server.write(cryptfuncs ? cryptfuncs.encrypt(data) : data);
            }
        });

        server.on("data", function (data) {
            if (!client_closeflag) {
                client.write(cryptfuncs ? cryptfuncs.decrypt(data) : data);
            }
        });
          
        client.on("end", function () {
            client_closeflag = 1;
            server.end();
        });
        
        server.on("end", function () {
            server_closeflag = 1;
            client.end();
        });

        client.on("error", function () {
            client_closeflag = 1;
            server.destroy();
        });
        
        server.on("error", function () {
            server_closeflag = 1;
            client.destroy();
        });

        client.on("timeout", function () {
            server.destroy();
            client.destroy();
        });
        
        server.on("timeout", function () {
            server.destroy();
            client.destroy();
        });

        server.on("connect", function (socket) {
            client.resume();
            server.resume();

            if (connopts) {
                connopts.connectfunc(client, server, connopts.req, connopts.buffer);
            }
        });
}

function standAloneConnectAction(client, server, req, buffer) {
    if (req.method == 'CONNECT') {
        client.write(new Buffer("HTTP/1.1 200 Connection established\r\nConnection: close\r\n\r\n"));
    } else {
        server.write(buffer);
    }
}

function proxyConnectAction(client, server, req, buffer) {
    if (req.method == 'CONNECT') {
        client.write(encrypt(new Buffer("HTTP/1.1 200 Connection established\r\nConnection: close\r\n\r\n")));
    } else {
        server.write(buffer);
    }
}

//在本地创建一个server监听本地serverport端口
net.createServer({ allowHalfOpen: true}, function (client) {
    if (connectproxy) {
        startService(
            client,
            { allowHalfOpen: true, port: serverport + 1, host: serverip},
            { 'encrypt': encrypt, 'decrypt': decrypt },
            null
        );

        return;
    }

    //首先监听浏览器的数据发送事件，直到收到的数据包含完整的http请求头
    var buffer = new Buffer(0);
    
    client.on('data', function (data) {
        buffer = buffer_add(buffer, data);

        if (buffer_find_body(buffer) < 0) {
            return;
        }
        
        var req = parse_request(buffer);
        
        if (!req) {
            return;
        }
        
        client.removeAllListeners('data');
        relay_connection(req);
    });
    
    //从http请求头部取得请求信息后，继续监听浏览器发送数据，同时连接目标服务器，并把目标服务器的数据传给浏览器
    function relay_connection(req) {
        console.log(req.method + ' ' + req.host + ':' + req.port);

        //如果请求不是CONNECT方法（GET, POST），那么替换掉头部的一些东西
        if (req.method != 'CONNECT') {
            //先从buffer中取出头部
            var _body_pos = buffer_find_body(buffer);

            if (_body_pos < 0) _body_pos = buffer.length;

            var header = buffer.slice(0, _body_pos).toString('utf8');

            //替换connection头
            header = header.replace(/(proxy-)?connection\:.+\r\n/ig, '')
                .replace(/Keep-Alive\:.+\r\n/i, '')
                .replace("\r\n", '\r\nConnection: close\r\n');
            
            //替换网址格式(去掉域名部分)
            if (req.httpVersion == '1.1') {
                var url = req.path.replace(/http\:\/\/[^\/]+/, '');
                if (url.path != url) header = header.replace(req.path, url);
            }
            
            buffer = buffer_add(new Buffer(header, 'utf8'), buffer.slice(_body_pos));
        }

        // second proxy mode
        if (!standalone) {
            startService(
                client,
                { allowHalfOpen: true, port: req.port, host: req.host},
                { 'encrypt': decrypt, 'decrypt': encrypt },
                { 'connectfunc': proxyConnectAction, 'req': req, 'buffer': buffer }
            );

            return;
        }

        // standalone proxy mode
        startService(
            client,
            { allowHalfOpen: true, port: req.port, host: req.host},
            null,
            { 'connectfunc': standAloneConnectAction, 'req': req, 'buffer': buffer }
        );
    }
}).listen(serverport);

console.log('Proxy server running at ' + serverip + ':' + serverport);

//处理各种错误
process.on('uncaughtException', function (err) {
    console.log("\nError!!!!");
    console.log(err);
});

/*
 从请求头部取得请求详细信息
 如果是 CONNECT 方法，那么会返回 { method,host,port,httpVersion}
 如果是 GET/POST 方法，那么返回 { metod,host,port,path,httpVersion}
*/
function parse_request(buffer) {
    var s = buffer.toString('utf8');
    
    var method = s.split('\n')[0].match(/^([A-Z]+)\s/)[1];
    
    if (method == 'CONNECT') {
        var arr = s.match(/^([A-Z]+)\s([^\:\s]+)\:(\d+)\sHTTP\/(\d.\d)/);
        
        if (arr && arr[1] && arr[2] && arr[3] && arr[4])
            return {
                method: arr[1],
                host: arr[2],
                port: arr[3],
                httpVersion: arr[4]
            };
    } else {
        var arr = s.match(/^([A-Z]+)\s([^\s]+)\sHTTP\/(\d.\d)/);
        
        if (arr && arr[1] && arr[2] && arr[3]) {
            var host = s.match(/Host\:\s+([^\n\s\r]+)/)[1];
            
            if (host) {
                var _p = host.split(':', 2);
                return {
                    method: arr[1],
                    host: _p[0],
                    port: _p[1] ? _p[1] : 80,
                    path: arr[2],
                    httpVersion: arr[3]
                };
            }
        }
    }
    
    return false;
}

/*
 两个buffer对象加起来
*/
function buffer_add(buf1, buf2) {
    // second proxy mode
    if (!standalone) {
        decrypt(buf2);
    }

    var re = new Buffer(buf1.length + buf2.length);
    
    buf1.copy(re);
    buf2.copy(re, buf1.length);
    
    return re;
}

/*
 从缓存中找到头部结束标记("\r\n\r\n")的位置
*/
function buffer_find_body(b) {
    for (var i = 0, len = b.length - 3; i < len; i++) {
        if (b[i] == 0x0d && b[i + 1] == 0x0a && b[i + 2] == 0x0d && b[i + 3] == 0x0a) {
            return i + 4;
        }
    }
    
    return -1;
}