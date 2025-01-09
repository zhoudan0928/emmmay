const express = require('express');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const app = express();

const DEFAULT_PORT = process.env.PORT || 8080;
const TARGET_HOST = process.env.EMBY_SERVER || ''; // 从环境变量获取emby地址

if (!TARGET_HOST) {
    console.error('EMBY_SERVER environment variable is not set');
    process.exit(1);
}

function log(message) {
    console.log(`[${new Date().toISOString()}] ${message}`);
}

function getDefaultUserAgent(isMobile = false) {
    if (isMobile) {
        return "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
    } else {
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    }
}

function transformHeaders(headers) {
    const isMobile = headers['sec-ch-ua-mobile'] === '?1';
    const newHeaders = new Headers();
    
    // 复制原始请求头
    for (const [key, value] of Object.entries(headers)) {
        if (key !== 'host' && key !== 'connection' && key !== 'origin') {
            newHeaders.set(key, value);
        }
    }
    
    // 设置新的请求头
    newHeaders.set('User-Agent', getDefaultUserAgent(isMobile));
    newHeaders.set('Host', TARGET_HOST.replace(/^https?:\/\//, ''));
    newHeaders.set('Origin', `https://${TARGET_HOST.replace(/^https?:\/\//, '')}`);
    
    return newHeaders;
}

// WebSocket处理
const wsServer = new WebSocket.Server({ noServer: true });

async function handleWebSocket(req, socket, head) {
    const targetUrl = `wss://${TARGET_HOST.replace(/^https?:\/\//, '')}${req.url}`;
    log(`建立WebSocket连接: ${targetUrl}`);

    try {
        const clientSocket = await new Promise((resolve) => {
            wsServer.handleUpgrade(req, socket, head, (ws) => {
                resolve(ws);
            });
        });

        const serverSocket = new WebSocket(targetUrl, {
            headers: transformHeaders(req.headers)
        });

        clientSocket.on('message', (data) => {
            if (serverSocket.readyState === WebSocket.OPEN) {
                serverSocket.send(data);
            }
        });

        serverSocket.on('message', (data) => {
            if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.send(data);
            }
        });

        clientSocket.on('close', () => {
            if (serverSocket.readyState === WebSocket.OPEN) {
                serverSocket.close();
            }
        });

        serverSocket.on('close', () => {
            if (clientSocket.readyState === WebSocket.OPEN) {
                clientSocket.close();
            }
        });

        clientSocket.on('error', (error) => {
            log(`客户端WebSocket错误: ${error.message}`);
        });

        serverSocket.on('error', (error) => {
            log(`服务器WebSocket错误: ${error.message}`);
        });
    } catch (error) {
        log(`WebSocket连接错误: ${error.message}`);
        socket.destroy();
    }
}

// HTTP请求处理
async function handleRequest(req, res) {
    try {
        const targetUrl = `https://${TARGET_HOST.replace(/^https?:\/\//, '')}${req.url}`;
        log(`代理HTTP请求: ${targetUrl}`);

        const proxyReq = await fetch(targetUrl, {
            method: req.method,
            headers: transformHeaders(req.headers),
            body: ['GET', 'HEAD'].includes(req.method) ? null : req,
            redirect: 'follow'
        });

        // 设置响应头
        const headers = new Headers(proxyReq.headers);
        headers.set('Access-Control-Allow-Origin', '*');
        headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        headers.set('Access-Control-Allow-Headers', '*');

        // 删除可能导致问题的响应头
        headers.delete('strict-transport-security');
        headers.delete('content-security-policy');

        // 设置响应
        res.status(proxyReq.status);
        for (const [key, value] of headers.entries()) {
            res.setHeader(key, value);
        }

        // 流式传输响应体
        proxyReq.body.pipe(res);
    } catch (error) {
        log(`代理错误: ${error.message}`);
        res.status(500).json({
            error: 'Proxy Error',
            message: error.message
        });
    }
}

// 健康检查端点
app.get('/healthz', (req, res) => {
    res.json({ status: 'healthy' });
});

// 处理所有请求
app.all('*', (req, res) => {
    handleRequest(req, res);
});

// 创建HTTP服务器
const server = app.listen(DEFAULT_PORT, '0.0.0.0', () => {
    log(`代理服务器运行在端口 ${DEFAULT_PORT}`);
});

// 处理WebSocket升级请求
server.on('upgrade', (req, socket, head) => {
    if (req.headers['upgrade']?.toLowerCase() === 'websocket') {
        handleWebSocket(req, socket, head);
    } else {
        socket.destroy();
    }
}); 