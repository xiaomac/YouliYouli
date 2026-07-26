// ==UserScript==
// @name         SmartDown 智慧学习下载脚本
// @version      1.0.0
// @description  支持国家中小学智慧教育平台上的正版教材/课件/精品课等资源和视频的下载。仅供个人学习使用。
// @author       xiaomac
// @match        https://basic.smartedu.cn/tchMaterial/detail*
// @match        https://basic.smartedu.cn/syncClassroom/classActivity*
// @match        https://basic.smartedu.cn/syncClassroom/prepare/detail*
// @match        https://basic.smartedu.cn/qualityCourse*
// @match        https://jpk.basic.smartedu.cn/yearQualityCourse*
// @grant        GM_xmlhttpRequest
// @connect      ykt.cbern.com.cn
// @connect      ykt.eduyun.cn
// @require      https://registry.npmmirror.com/jszip/3.10.1/files/dist/jszip.min.js
// @require      https://registry.npmmirror.com/@ffmpeg/ffmpeg/0.12.15/files/dist/umd/ffmpeg.js
// @icon         https://basic.smartedu.cn/favicon.ico
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/xiaomac/YouliYouli/main/util/SmartDown.user.js
// @updateURL    https://raw.githubusercontent.com/xiaomac/YouliYouli/main/util/SmartDown.user.js
// ==/UserScript==
(function () {
    'use strict';

    // jszip.min.js(通过 @require 注入)内部所有异步调度都靠 setImmediate，浏览器原生
    // 没有这个 API，jszip 的 dist 包里自带了社区版 polyfill，优先用 window.postMessage
    // 自发自收来模拟。但 Tampermonkey 的沙箱化脚本运行在独立 JS Realm 里，postMessage
    // 发出去之后能否正确回环到沙箱内部注册的 message 监听器不可靠——一旦回环丢失，
    // postMessage 本身不报错，只是排入的回调永远不会执行，表现为 zip.generateAsync()
    // 卡死不进不退、无报错、无进度回调(实测与数据量大小无关，1个"hello world"文件也一样)。
    // jszip 每次调用都是按裸标识符 setImmediate 现查全局作用域(没有在加载时缓存引用)，
    // 所以只要在这里覆盖一次全局 setImmediate 即可，不需要改动 jszip 本身；这个覆盖
    // 发生在 @require 的脚本已经装好它自己那份坏 polyfill 之后，但早于任何真正调用
    // generateAsync() 的时机，能完全生效。
    //
    // 用 MessageChannel 而不是 setTimeout 来实现：jszip 打包大文件时按16KB一个chunk
    // 处理数据，每个chunk都要调度一次下一个tick，100MB+的数据就是六七千次调度。
    // setTimeout(fn,0) 连续嵌套调用超过5层后会被浏览器强制限流到最短4ms一次(HTML标准
    // 的nested timeout节流规则)，几千次 tick 累加起来能拖到几分钟。MessageChannel的
    // 消息事件走的是"任务队列"而非"定时器"任务源，不受这条节流规则限制，能做到接近
    // 真正的零延迟调度；而且它是两个独立port对象直接通信，不依赖window级别的
    // postMessage/message事件循环，不会重现上面那个"沙箱里回环丢失"的问题。
    (function setupSetImmediate() {
        if (typeof MessageChannel === 'undefined') {
            window.setImmediate = function (fn, ...args) {
                return setTimeout(fn, 0, ...args);
            };
            return;
        }
        const channel = new MessageChannel();
        const queue = [];
        channel.port1.onmessage = function () {
            const task = queue.shift();
            if (task) task();
        };
        window.setImmediate = function (fn, ...args) {
            queue.push(() => fn(...args));
            channel.port2.postMessage(null);
        };
    })();

    // ==================================================================
    // 0. 常量
    // ==================================================================

    const SDP_APP_ID = 'e5649925-441d-4a53-b525-51a2f1c4e0a8';
    const STORAGE_KEY = `ND_UC_AUTH-${SDP_APP_ID}&ncet-xedu&token`;
    const API_SERVERS = ['s-file-2', 's-file-1', 's-file-3'];

    // ffmpeg-core(单线程版，不需要 SharedArrayBuffer/COOP/COEP) 走阿里云 npmmirror 静态
    // 文件直链，体积大(~30MB)不内嵌，运行时由 worker 内部动态 import()/fetch()；已实测
    // 该 CDN 会按请求 Origin 反射 Access-Control-Allow-Origin，跨域没问题。
    const FFMPEG_CORE_BASE = 'https://registry.npmmirror.com/@ffmpeg/core/0.12.10/files/dist/esm/ffmpeg-core';

    // ffmpeg.wasm 的 worker 入口(合并自 @ffmpeg/ffmpeg@0.12.15 的
    // dist/esm/{const,errors,worker}.js，去掉 import/export 压平成自包含文件)。
    // @require 注入的脚本不是通过真实 <script src> 标签加载的，ffmpeg.js 官方那套
    // "自动探测同目录 worker 文件"机制(依赖 document.currentScript)会失效，所以改用
    // 库自带的 classWorkerURL 参数手动指定——但 Worker() 不能直接跨域加载脚本，
    // 只能把 worker 源码文本转成 blob: URL 再传给它，这份源码就只能内嵌了(体积很小)。
    const FFMPEG_WORKER_SRC_B64 = 'Ly8g5ZCI5bm26IeqIEBmZm1wZWcvZmZtcGVnQDAuMTIuMTUg55qEIGRpc3QvZXNtL3tjb25zdCxlcnJvcnMsd29ya2VyfS5qc++8jAovLyDljrvmjokgaW1wb3J0L2V4cG9ydCDor63ms5XljovlubPmiJDkuIDkuKroh6rljIXlkKvmlofku7bvvIzkvpsgY2xhc3NXb3JrZXJVUkwg55So44CCCmNvbnN0IEZGTWVzc2FnZVR5cGUgPSB7CiAgICBMT0FEOiAiTE9BRCIsIEVYRUM6ICJFWEVDIiwgRkZQUk9CRTogIkZGUFJPQkUiLCBXUklURV9GSUxFOiAiV1JJVEVfRklMRSIsCiAgICBSRUFEX0ZJTEU6ICJSRUFEX0ZJTEUiLCBERUxFVEVfRklMRTogIkRFTEVURV9GSUxFIiwgUkVOQU1FOiAiUkVOQU1FIiwKICAgIENSRUFURV9ESVI6ICJDUkVBVEVfRElSIiwgTElTVF9ESVI6ICJMSVNUX0RJUiIsIERFTEVURV9ESVI6ICJERUxFVEVfRElSIiwKICAgIEVSUk9SOiAiRVJST1IiLCBET1dOTE9BRDogIkRPV05MT0FEIiwgUFJPR1JFU1M6ICJQUk9HUkVTUyIsIExPRzogIkxPRyIsCiAgICBNT1VOVDogIk1PVU5UIiwgVU5NT1VOVDogIlVOTU9VTlQiLAp9Owpjb25zdCBFUlJPUl9VTktOT1dOX01FU1NBR0VfVFlQRSA9IG5ldyBFcnJvcigidW5rbm93biBtZXNzYWdlIHR5cGUiKTsKY29uc3QgRVJST1JfTk9UX0xPQURFRCA9IG5ldyBFcnJvcigiZmZtcGVnIGlzIG5vdCBsb2FkZWQsIGNhbGwgYXdhaXQgZmZtcGVnLmxvYWQoKSBmaXJzdCIpOwpjb25zdCBFUlJPUl9JTVBPUlRfRkFJTFVSRSA9IG5ldyBFcnJvcigiZmFpbGVkIHRvIGltcG9ydCBmZm1wZWctY29yZS5qcyIpOwoKbGV0IGZmbXBlZzsKY29uc3QgbG9hZCA9IGFzeW5jICh7IGNvcmVVUkw6IF9jb3JlVVJMLCB3YXNtVVJMOiBfd2FzbVVSTCwgd29ya2VyVVJMOiBfd29ya2VyVVJMIH0pID0+IHsKICAgIGNvbnN0IGZpcnN0ID0gIWZmbXBlZzsKICAgIHRyeSB7CiAgICAgICAgaW1wb3J0U2NyaXB0cyhfY29yZVVSTCk7CiAgICB9CiAgICBjYXRjaCB7CiAgICAgICAgc2VsZi5jcmVhdGVGRm1wZWdDb3JlID0gKGF3YWl0IGltcG9ydChfY29yZVVSTCkpLmRlZmF1bHQ7CiAgICAgICAgaWYgKCFzZWxmLmNyZWF0ZUZGbXBlZ0NvcmUpIHsKICAgICAgICAgICAgdGhyb3cgRVJST1JfSU1QT1JUX0ZBSUxVUkU7CiAgICAgICAgfQogICAgfQogICAgY29uc3QgY29yZVVSTCA9IF9jb3JlVVJMOwogICAgY29uc3Qgd2FzbVVSTCA9IF93YXNtVVJMID8gX3dhc21VUkwgOiBfY29yZVVSTC5yZXBsYWNlKC8uanMkL2csICIud2FzbSIpOwogICAgY29uc3Qgd29ya2VyVVJMID0gX3dvcmtlclVSTCA/IF93b3JrZXJVUkwgOiBfY29yZVVSTC5yZXBsYWNlKC8uanMkL2csICIud29ya2VyLmpzIik7CiAgICBmZm1wZWcgPSBhd2FpdCBzZWxmLmNyZWF0ZUZGbXBlZ0NvcmUoewogICAgICAgIG1haW5TY3JpcHRVcmxPckJsb2I6IGNvcmVVUkwgKyAiIyIgKyBidG9hKEpTT04uc3RyaW5naWZ5KHsgd2FzbVVSTCwgd29ya2VyVVJMIH0pKSwKICAgIH0pOwogICAgZmZtcGVnLnNldExvZ2dlcigoZGF0YSkgPT4gc2VsZi5wb3N0TWVzc2FnZSh7IHR5cGU6IEZGTWVzc2FnZVR5cGUuTE9HLCBkYXRhIH0pKTsKICAgIGZmbXBlZy5zZXRQcm9ncmVzcygoZGF0YSkgPT4gc2VsZi5wb3N0TWVzc2FnZSh7IHR5cGU6IEZGTWVzc2FnZVR5cGUuUFJPR1JFU1MsIGRhdGEgfSkpOwogICAgcmV0dXJuIGZpcnN0Owp9Owpjb25zdCBleGVjID0gKHsgYXJncywgdGltZW91dCA9IC0xIH0pID0+IHsKICAgIGZmbXBlZy5zZXRUaW1lb3V0KHRpbWVvdXQpOwogICAgZmZtcGVnLmV4ZWMoLi4uYXJncyk7CiAgICBjb25zdCByZXQgPSBmZm1wZWcucmV0OwogICAgZmZtcGVnLnJlc2V0KCk7CiAgICByZXR1cm4gcmV0Owp9Owpjb25zdCBmZnByb2JlID0gKHsgYXJncywgdGltZW91dCA9IC0xIH0pID0+IHsKICAgIGZmbXBlZy5zZXRUaW1lb3V0KHRpbWVvdXQpOwogICAgZmZtcGVnLmZmcHJvYmUoLi4uYXJncyk7CiAgICBjb25zdCByZXQgPSBmZm1wZWcucmV0OwogICAgZmZtcGVnLnJlc2V0KCk7CiAgICByZXR1cm4gcmV0Owp9Owpjb25zdCB3cml0ZUZpbGUgPSAoeyBwYXRoLCBkYXRhIH0pID0+IHsKICAgIGZmbXBlZy5GUy53cml0ZUZpbGUocGF0aCwgZGF0YSk7CiAgICByZXR1cm4gdHJ1ZTsKfTsKY29uc3QgcmVhZEZpbGUgPSAoeyBwYXRoLCBlbmNvZGluZyB9KSA9PiBmZm1wZWcuRlMucmVhZEZpbGUocGF0aCwgeyBlbmNvZGluZyB9KTsKY29uc3QgZGVsZXRlRmlsZSA9ICh7IHBhdGggfSkgPT4gewogICAgZmZtcGVnLkZTLnVubGluayhwYXRoKTsKICAgIHJldHVybiB0cnVlOwp9Owpjb25zdCByZW5hbWUgPSAoeyBvbGRQYXRoLCBuZXdQYXRoIH0pID0+IHsKICAgIGZmbXBlZy5GUy5yZW5hbWUob2xkUGF0aCwgbmV3UGF0aCk7CiAgICByZXR1cm4gdHJ1ZTsKfTsKY29uc3QgY3JlYXRlRGlyID0gKHsgcGF0aCB9KSA9PiB7CiAgICBmZm1wZWcuRlMubWtkaXIocGF0aCk7CiAgICByZXR1cm4gdHJ1ZTsKfTsKY29uc3QgbGlzdERpciA9ICh7IHBhdGggfSkgPT4gewogICAgY29uc3QgbmFtZXMgPSBmZm1wZWcuRlMucmVhZGRpcihwYXRoKTsKICAgIGNvbnN0IG5vZGVzID0gW107CiAgICBmb3IgKGNvbnN0IG5hbWUgb2YgbmFtZXMpIHsKICAgICAgICBjb25zdCBzdGF0ID0gZmZtcGVnLkZTLnN0YXQoYCR7cGF0aH0vJHtuYW1lfWApOwogICAgICAgIGNvbnN0IGlzRGlyID0gZmZtcGVnLkZTLmlzRGlyKHN0YXQubW9kZSk7CiAgICAgICAgbm9kZXMucHVzaCh7IG5hbWUsIGlzRGlyIH0pOwogICAgfQogICAgcmV0dXJuIG5vZGVzOwp9Owpjb25zdCBkZWxldGVEaXIgPSAoeyBwYXRoIH0pID0+IHsKICAgIGZmbXBlZy5GUy5ybWRpcihwYXRoKTsKICAgIHJldHVybiB0cnVlOwp9Owpjb25zdCBtb3VudCA9ICh7IGZzVHlwZSwgb3B0aW9ucywgbW91bnRQb2ludCB9KSA9PiB7CiAgICBjb25zdCBzdHIgPSBmc1R5cGU7CiAgICBjb25zdCBmcyA9IGZmbXBlZy5GUy5maWxlc3lzdGVtc1tzdHJdOwogICAgaWYgKCFmcykgcmV0dXJuIGZhbHNlOwogICAgZmZtcGVnLkZTLm1vdW50KGZzLCBvcHRpb25zLCBtb3VudFBvaW50KTsKICAgIHJldHVybiB0cnVlOwp9Owpjb25zdCB1bm1vdW50ID0gKHsgbW91bnRQb2ludCB9KSA9PiB7CiAgICBmZm1wZWcuRlMudW5tb3VudChtb3VudFBvaW50KTsKICAgIHJldHVybiB0cnVlOwp9OwpzZWxmLm9ubWVzc2FnZSA9IGFzeW5jICh7IGRhdGE6IHsgaWQsIHR5cGUsIGRhdGE6IF9kYXRhIH0gfSkgPT4gewogICAgY29uc3QgdHJhbnMgPSBbXTsKICAgIGxldCBkYXRhOwogICAgdHJ5IHsKICAgICAgICBpZiAodHlwZSAhPT0gRkZNZXNzYWdlVHlwZS5MT0FEICYmICFmZm1wZWcpIHRocm93IEVSUk9SX05PVF9MT0FERUQ7CiAgICAgICAgc3dpdGNoICh0eXBlKSB7CiAgICAgICAgICAgIGNhc2UgRkZNZXNzYWdlVHlwZS5MT0FEOiBkYXRhID0gYXdhaXQgbG9hZChfZGF0YSk7IGJyZWFrOwogICAgICAgICAgICBjYXNlIEZGTWVzc2FnZVR5cGUuRVhFQzogZGF0YSA9IGV4ZWMoX2RhdGEpOyBicmVhazsKICAgICAgICAgICAgY2FzZSBGRk1lc3NhZ2VUeXBlLkZGUFJPQkU6IGRhdGEgPSBmZnByb2JlKF9kYXRhKTsgYnJlYWs7CiAgICAgICAgICAgIGNhc2UgRkZNZXNzYWdlVHlwZS5XUklURV9GSUxFOiBkYXRhID0gd3JpdGVGaWxlKF9kYXRhKTsgYnJlYWs7CiAgICAgICAgICAgIGNhc2UgRkZNZXNzYWdlVHlwZS5SRUFEX0ZJTEU6IGRhdGEgPSByZWFkRmlsZShfZGF0YSk7IGJyZWFrOwogICAgICAgICAgICBjYXNlIEZGTWVzc2FnZVR5cGUuREVMRVRFX0ZJTEU6IGRhdGEgPSBkZWxldGVGaWxlKF9kYXRhKTsgYnJlYWs7CiAgICAgICAgICAgIGNhc2UgRkZNZXNzYWdlVHlwZS5SRU5BTUU6IGRhdGEgPSByZW5hbWUoX2RhdGEpOyBicmVhazsKICAgICAgICAgICAgY2FzZSBGRk1lc3NhZ2VUeXBlLkNSRUFURV9ESVI6IGRhdGEgPSBjcmVhdGVEaXIoX2RhdGEpOyBicmVhazsKICAgICAgICAgICAgY2FzZSBGRk1lc3NhZ2VUeXBlLkxJU1RfRElSOiBkYXRhID0gbGlzdERpcihfZGF0YSk7IGJyZWFrOwogICAgICAgICAgICBjYXNlIEZGTWVzc2FnZVR5cGUuREVMRVRFX0RJUjogZGF0YSA9IGRlbGV0ZURpcihfZGF0YSk7IGJyZWFrOwogICAgICAgICAgICBjYXNlIEZGTWVzc2FnZVR5cGUuTU9VTlQ6IGRhdGEgPSBtb3VudChfZGF0YSk7IGJyZWFrOwogICAgICAgICAgICBjYXNlIEZGTWVzc2FnZVR5cGUuVU5NT1VOVDogZGF0YSA9IHVubW91bnQoX2RhdGEpOyBicmVhazsKICAgICAgICAgICAgZGVmYXVsdDogdGhyb3cgRVJST1JfVU5LTk9XTl9NRVNTQUdFX1RZUEU7CiAgICAgICAgfQogICAgfQogICAgY2F0Y2ggKGUpIHsKICAgICAgICBzZWxmLnBvc3RNZXNzYWdlKHsgaWQsIHR5cGU6IEZGTWVzc2FnZVR5cGUuRVJST1IsIGRhdGE6IGUudG9TdHJpbmcoKSB9KTsKICAgICAgICByZXR1cm47CiAgICB9CiAgICBpZiAoZGF0YSBpbnN0YW5jZW9mIFVpbnQ4QXJyYXkpIHsKICAgICAgICB0cmFucy5wdXNoKGRhdGEuYnVmZmVyKTsKICAgIH0KICAgIHNlbGYucG9zdE1lc3NhZ2UoeyBpZCwgdHlwZSwgZGF0YSB9LCB0cmFucyk7Cn07Cg==';

    // ==================================================================
    // 1. 密码学工具：MD5 / AES-128-ECB(纯JS，浏览器WebCrypto不支持ECB) / PKCS7
    //    只用来解开视频分片 content key 的 ECB 包装，分片本身用 WebCrypto 的 AES-CBC。
    // ==================================================================

    function md5(str) {
        function rotateLeft(x, c) { return (x << c) | (x >>> (32 - c)); }
        function addUnsigned(x, y) {
            const x4 = x & 0x40000000, y4 = y & 0x40000000;
            const x8 = x & 0x80000000, y8 = y & 0x80000000;
            const result = (x & 0x3FFFFFFF) + (y & 0x3FFFFFFF);
            if (x4 & y4) return result ^ 0x80000000 ^ x8 ^ y8;
            if (x4 | y4) {
                if (result & 0x40000000) return result ^ 0xC0000000 ^ x8 ^ y8;
                return result ^ 0x40000000 ^ x8 ^ y8;
            }
            return result ^ x8 ^ y8;
        }
        function F(x, y, z) { return (x & y) | (~x & z); }
        function G(x, y, z) { return (x & z) | (y & ~z); }
        function H(x, y, z) { return x ^ y ^ z; }
        function I(x, y, z) { return y ^ (x | (~z)); }
        function FF(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
        function GG(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
        function HH(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }
        function II(a, b, c, d, x, s, ac) { a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac)); return addUnsigned(rotateLeft(a, s), b); }

        function convertToWordArray(s) {
            let wordCount;
            const messageLength = s.length;
            const numberOfWordsTempOne = messageLength + 8;
            const numberOfWordsTempTwo = (numberOfWordsTempOne - (numberOfWordsTempOne % 64)) / 64;
            const numberOfWords = (numberOfWordsTempTwo + 1) * 16;
            const wordArray = new Array(numberOfWords).fill(0);
            let bytePosition, byteCount = 0;
            while (byteCount < messageLength) {
                wordCount = (byteCount - (byteCount % 4)) / 4;
                bytePosition = (byteCount % 4) * 8;
                wordArray[wordCount] = wordArray[wordCount] | (s.charCodeAt(byteCount) << bytePosition);
                byteCount++;
            }
            wordCount = (byteCount - (byteCount % 4)) / 4;
            bytePosition = (byteCount % 4) * 8;
            wordArray[wordCount] = wordArray[wordCount] | (0x80 << bytePosition);
            wordArray[numberOfWords - 2] = messageLength << 3;
            wordArray[numberOfWords - 1] = messageLength >>> 29;
            return wordArray;
        }
        function wordToHex(value) {
            let hex = '';
            for (let count = 0; count <= 3; count++) {
                const byte = (value >>> (count * 8)) & 255;
                hex += ('0' + byte.toString(16)).slice(-2);
            }
            return hex;
        }
        function utf8Encode(s) { return unescape(encodeURIComponent(s)); }

        const S11=7,S12=12,S13=17,S14=22, S21=5,S22=9,S23=14,S24=20, S31=4,S32=11,S33=16,S34=23, S41=6,S42=10,S43=15,S44=21;

        str = utf8Encode(str);
        const x = convertToWordArray(str);
        let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;

        for (let k = 0; k < x.length; k += 16) {
            const AA = a, BB = b, CC = c, DD = d;
            a = FF(a,b,c,d,x[k+0],S11,0xD76AA478); d = FF(d,a,b,c,x[k+1],S12,0xE8C7B756); c = FF(c,d,a,b,x[k+2],S13,0x242070DB); b = FF(b,c,d,a,x[k+3],S14,0xC1BDCEEE);
            a = FF(a,b,c,d,x[k+4],S11,0xF57C0FAF); d = FF(d,a,b,c,x[k+5],S12,0x4787C62A); c = FF(c,d,a,b,x[k+6],S13,0xA8304613); b = FF(b,c,d,a,x[k+7],S14,0xFD469501);
            a = FF(a,b,c,d,x[k+8],S11,0x698098D8); d = FF(d,a,b,c,x[k+9],S12,0x8B44F7AF); c = FF(c,d,a,b,x[k+10],S13,0xFFFF5BB1); b = FF(b,c,d,a,x[k+11],S14,0x895CD7BE);
            a = FF(a,b,c,d,x[k+12],S11,0x6B901122); d = FF(d,a,b,c,x[k+13],S12,0xFD987193); c = FF(c,d,a,b,x[k+14],S13,0xA679438E); b = FF(b,c,d,a,x[k+15],S14,0x49B40821);

            a = GG(a,b,c,d,x[k+1],S21,0xF61E2562); d = GG(d,a,b,c,x[k+6],S22,0xC040B340); c = GG(c,d,a,b,x[k+11],S23,0x265E5A51); b = GG(b,c,d,a,x[k+0],S24,0xE9B6C7AA);
            a = GG(a,b,c,d,x[k+5],S21,0xD62F105D); d = GG(d,a,b,c,x[k+10],S22,0x02441453); c = GG(c,d,a,b,x[k+15],S23,0xD8A1E681); b = GG(b,c,d,a,x[k+4],S24,0xE7D3FBC8);
            a = GG(a,b,c,d,x[k+9],S21,0x21E1CDE6); d = GG(d,a,b,c,x[k+14],S22,0xC33707D6); c = GG(c,d,a,b,x[k+3],S23,0xF4D50D87); b = GG(b,c,d,a,x[k+8],S24,0x455A14ED);
            a = GG(a,b,c,d,x[k+13],S21,0xA9E3E905); d = GG(d,a,b,c,x[k+2],S22,0xFCEFA3F8); c = GG(c,d,a,b,x[k+7],S23,0x676F02D9); b = GG(b,c,d,a,x[k+12],S24,0x8D2A4C8A);

            a = HH(a,b,c,d,x[k+5],S31,0xFFFA3942); d = HH(d,a,b,c,x[k+8],S32,0x8771F681); c = HH(c,d,a,b,x[k+11],S33,0x6D9D6122); b = HH(b,c,d,a,x[k+14],S34,0xFDE5380C);
            a = HH(a,b,c,d,x[k+1],S31,0xA4BEEA44); d = HH(d,a,b,c,x[k+4],S32,0x4BDECFA9); c = HH(c,d,a,b,x[k+7],S33,0xF6BB4B60); b = HH(b,c,d,a,x[k+10],S34,0xBEBFBC70);
            a = HH(a,b,c,d,x[k+13],S31,0x289B7EC6); d = HH(d,a,b,c,x[k+0],S32,0xEAA127FA); c = HH(c,d,a,b,x[k+3],S33,0xD4EF3085); b = HH(b,c,d,a,x[k+6],S34,0x04881D05);
            a = HH(a,b,c,d,x[k+9],S31,0xD9D4D039); d = HH(d,a,b,c,x[k+12],S32,0xE6DB99E5); c = HH(c,d,a,b,x[k+15],S33,0x1FA27CF8); b = HH(b,c,d,a,x[k+2],S34,0xC4AC5665);

            a = II(a,b,c,d,x[k+0],S41,0xF4292244); d = II(d,a,b,c,x[k+7],S42,0x432AFF97); c = II(c,d,a,b,x[k+14],S43,0xAB9423A7); b = II(b,c,d,a,x[k+5],S44,0xFC93A039);
            a = II(a,b,c,d,x[k+12],S41,0x655B59C3); d = II(d,a,b,c,x[k+3],S42,0x8F0CCC92); c = II(c,d,a,b,x[k+10],S43,0xFFEFF47D); b = II(b,c,d,a,x[k+1],S44,0x85845DD1);
            a = II(a,b,c,d,x[k+8],S41,0x6FA87E4F); d = II(d,a,b,c,x[k+15],S42,0xFE2CE6E0); c = II(c,d,a,b,x[k+6],S43,0xA3014314); b = II(b,c,d,a,x[k+13],S44,0x4E0811A1);
            a = II(a,b,c,d,x[k+4],S41,0xF7537E82); d = II(d,a,b,c,x[k+11],S42,0xBD3AF235); c = II(c,d,a,b,x[k+2],S43,0x2AD7D2BB); b = II(b,c,d,a,x[k+9],S44,0xEB86D391);

            a = addUnsigned(a, AA); b = addUnsigned(b, BB); c = addUnsigned(c, CC); d = addUnsigned(d, DD);
        }
        return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
    }

    const Sbox = [
        0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
        0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
        0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
        0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
        0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
        0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
        0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
        0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
        0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
        0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
        0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
        0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
        0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
        0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
        0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
        0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
    ];
    const InvSbox = new Array(256);
    for (let i = 0; i < 256; i++) InvSbox[Sbox[i]] = i;
    const Rcon = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

    function keyExpansionAES128(key) {
        const Nk = 4, Nr = 10;
        const w = new Array(4 * (Nr + 1));
        for (let i = 0; i < Nk; i++) w[i] = [key[4*i], key[4*i+1], key[4*i+2], key[4*i+3]];
        for (let i = Nk; i < 4 * (Nr + 1); i++) {
            let temp = w[i-1].slice();
            if (i % Nk === 0) {
                temp = [temp[1], temp[2], temp[3], temp[0]];
                temp = temp.map((b) => Sbox[b]);
                temp[0] ^= Rcon[i / Nk - 1];
            }
            w[i] = [w[i-Nk][0]^temp[0], w[i-Nk][1]^temp[1], w[i-Nk][2]^temp[2], w[i-Nk][3]^temp[3]];
        }
        return w;
    }
    function gmul(a, b) {
        let p = 0;
        for (let i = 0; i < 8; i++) {
            if (b & 1) p ^= a;
            const hi = a & 0x80;
            a = (a << 1) & 0xff;
            if (hi) a ^= 0x1b;
            b >>= 1;
        }
        return p & 0xff;
    }
    function invSubBytes(state) { for (let i = 0; i < 16; i++) state[i] = InvSbox[state[i]]; }
    function invShiftRows(state) {
        const s = state.slice();
        for (let r = 1; r < 4; r++)
            for (let c = 0; c < 4; c++)
                state[c*4+r] = s[((c - r + 4) % 4) * 4 + r];
    }
    function invMixColumns(state) {
        for (let c = 0; c < 4; c++) {
            const a0=state[c*4+0], a1=state[c*4+1], a2=state[c*4+2], a3=state[c*4+3];
            state[c*4+0] = gmul(a0,0x0e)^gmul(a1,0x0b)^gmul(a2,0x0d)^gmul(a3,0x09);
            state[c*4+1] = gmul(a0,0x09)^gmul(a1,0x0e)^gmul(a2,0x0b)^gmul(a3,0x0d);
            state[c*4+2] = gmul(a0,0x0d)^gmul(a1,0x09)^gmul(a2,0x0e)^gmul(a3,0x0b);
            state[c*4+3] = gmul(a0,0x0b)^gmul(a1,0x0d)^gmul(a2,0x09)^gmul(a3,0x0e);
        }
    }
    function addRoundKey(state, w, round) {
        for (let c = 0; c < 4; c++)
            for (let r = 0; r < 4; r++)
                state[c*4+r] ^= w[round*4+c][r];
    }
    function aes128DecryptBlock(inputBytes, w) {
        const Nr = 10;
        let state = new Array(16);
        for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) state[c*4+r] = inputBytes[c*4+r];
        addRoundKey(state, w, Nr);
        for (let round = Nr - 1; round >= 1; round--) {
            invShiftRows(state);
            invSubBytes(state);
            addRoundKey(state, w, round);
            invMixColumns(state);
        }
        invShiftRows(state);
        invSubBytes(state);
        addRoundKey(state, w, 0);
        return state;
    }
    function aesEcbDecrypt(cipherBytes, keyBytes) {
        const w = keyExpansionAES128(keyBytes);
        const out = new Uint8Array(cipherBytes.length);
        for (let off = 0; off < cipherBytes.length; off += 16) {
            const block = cipherBytes.slice(off, off + 16);
            out.set(aes128DecryptBlock(block, w), off);
        }
        return out;
    }
    function pkcs7Unpad(bytes) {
        if (bytes.length === 0) return bytes;
        const pad = bytes[bytes.length - 1];
        if (pad <= 0 || pad > bytes.length) return bytes;
        return bytes.slice(0, bytes.length - pad);
    }
    function hexToBytes(hex) {
        hex = hex.replace(/^0x/i, '');
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
        return bytes;
    }
    function base64ToBytes(b64) {
        const binStr = atob(b64);
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
        return bytes;
    }

    // ==================================================================
    // 2. GM_xmlhttpRequest 封装（绕过CORS，支持自定义header）
    // ==================================================================

    // 之前这里只写了 ontimeout 回调，却忘了把 timeout 传给 GM_xmlhttpRequest，
    // 等于超时机制根本没启用——请求一旦卡住(既不成功也不报错)，Promise 就永远
    // 悬着，界面卡死也不会有任何报错。必须显式给个超时时长才会真正生效。
    function gmRequest(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: options.method || 'GET',
                url,
                headers: options.headers || {},
                responseType: options.responseType || 'text',
                timeout: options.timeout || 30000,
                onload: (resp) => {
                    if (resp.status >= 200 && resp.status < 300) resolve(resp);
                    else reject(new Error(`HTTP ${resp.status}: ${url}`));
                },
                onerror: () => reject(new Error(`网络请求失败: ${url}`)),
                ontimeout: () => reject(new Error(`请求超时(${(options.timeout || 30000) / 1000}s): ${url}`)),
            });
        });
    }
    async function gmRequestJSON(url, authHeader) {
        const resp = await gmRequest(url, { headers: { 'x-nd-auth': authHeader } });
        return JSON.parse(resp.responseText);
    }
    async function gmRequestArrayBuffer(url, authHeader) {
        // 分片文件比 JSON 大一些，超时时间放宽到 45s。
        const resp = await gmRequest(url, { headers: { 'x-nd-auth': authHeader }, responseType: 'arraybuffer', timeout: 45000 });
        return resp.response;
    }

    // ==================================================================
    // 3. ffmpeg.wasm 封装：ts->mp4(优先流复制，不重新编码) / ogg->mp3
    // ==================================================================

    let ffmpegWorkerBlobUrl = null;
    function getFFmpegWorkerBlobUrl() {
        if (!ffmpegWorkerBlobUrl) {
            const src = atob(FFMPEG_WORKER_SRC_B64);
            ffmpegWorkerBlobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        }
        return ffmpegWorkerBlobUrl;
    }

    let ffmpegInstance = null;
    let ffmpegLoadPromise = null;
    function getFFmpeg() {
        if (ffmpegInstance) return Promise.resolve(ffmpegInstance);
        if (!ffmpegLoadPromise) {
            ffmpegLoadPromise = (async () => {
                if (typeof FFmpegWASM === 'undefined' || !FFmpegWASM.FFmpeg) {
                    throw new Error('ffmpeg.js 未能正确加载(FFmpegWASM 不存在)，请检查网络是否能访问 registry.npmmirror.com。');
                }
                const instance = new FFmpegWASM.FFmpeg();
                await instance.load({
                    classWorkerURL: getFFmpegWorkerBlobUrl(),
                    coreURL: `${FFMPEG_CORE_BASE}.js`,
                    wasmURL: `${FFMPEG_CORE_BASE}.wasm`,
                });
                ffmpegInstance = instance;
                return instance;
            })().catch((error) => {
                ffmpegLoadPromise = null; // 加载失败允许下次重试
                throw error;
            });
        }
        return ffmpegLoadPromise;
    }

    // input/output 文件名带上每次请求的唯一标记，避免并发转码任务在 ffmpeg 虚拟文件系统
    // 里撞同一个文件名(报 ErrnoError: FS error)。
    const TRANSCODE_JOBS = {
        video: {
            inputExt: 'ts', outputExt: 'mp4', mime: 'video/mp4',
            buildArgs: (input, output) => ['-i', input, '-c', 'copy', '-movflags', '+faststart', output],
            // 分片是逐段下载解密后直接拼接成一个 ts 的，分片交界处时间戳大概率不连续/不
            // 单调，-c copy 对此很挑剔；重新编码这条路必须显式规整时间戳，否则同样会失败。
            buildFallbackArgs: (input, output) => [
                '-fflags', '+genpts+igndts', '-i', input, '-c:v', 'libx264', '-c:a', 'aac',
                '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', output,
            ],
        },
        audio: {
            inputExt: 'ogg', outputExt: 'mp3', mime: 'audio/mpeg',
            buildArgs: (input, output) => ['-i', input, '-c:a', 'libmp3lame', '-q:a', '2', output],
            buildFallbackArgs: null,
        },
    };
    const LOG_TAIL_SIZE = 30;

    // 转码完成后返回一个 Blob(不像浏览器扩展那样要跨上下文传输，用户脚本单一执行环境
    // 里直接拿到内存里的数据就行)。
    async function transcode(kind, arrayBuffer, onProgress) {
        const job = TRANSCODE_JOBS[kind];
        if (!job) throw new Error(`未知的转码类型: ${kind}`);

        const instance = await getFFmpeg();
        const requestTag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const input = `input-${requestTag}.${job.inputExt}`;
        const output = `output-${requestTag}.${job.outputExt}`;

        const logLines = [];
        const logHandler = ({ message }) => {
            logLines.push(message);
            if (logLines.length > LOG_TAIL_SIZE) logLines.shift();
        };
        const progressHandler = ({ progress }) => {
            if (Number.isFinite(progress)) onProgress(Math.max(0, Math.min(100, Math.round(progress * 100))));
        };
        instance.on('log', logHandler);
        instance.on('progress', progressHandler);

        // 把每一步都单独包一层，报错时带上"是哪一步失败的" + 这一步ffmpeg自己打印了什么
        // 日志，而不是让 ErrnoError 这种没有上下文的底层异常直接冒出来。
        function describeFailure(label, reasonText) {
            const detail = logLines.length ? logLines.join('\n') : '(ffmpeg 未输出任何日志)';
            return new Error(`[${label}] ${reasonText}\n${detail}`);
        }
        async function step(label, fn) {
            logLines.length = 0;
            try { return await fn(); }
            catch (error) { throw describeFailure(label, (error && error.message) || String(error)); }
        }
        // exec() 失败时不会 reject，而是 resolve 出一个非0退出码——必须显式检查，
        // 否则命令其实跑失败了会被当成成功，直到读输出文件时才炸出不知所云的错误。
        async function execStep(label, args) {
            const ret = await step(label, () => instance.exec(args));
            if (ret !== 0) throw describeFailure(label, `ffmpeg 返回非零退出码: ${ret}`);
            return ret;
        }

        try {
            await step('写入源文件', () => instance.writeFile(input, new Uint8Array(arrayBuffer)));
            try {
                await execStep('转码(流复制)', job.buildArgs(input, output));
            } catch (execError) {
                if (!job.buildFallbackArgs) throw execError;
                await execStep('转码(重新编码回退)', job.buildFallbackArgs(input, output));
            }
            const data = await step('读取输出文件', () => instance.readFile(output));
            // 返回裸的 Uint8Array 而不是 Blob：JSZip 处理 Blob 类型的文件内容要经过
            // 额外的异步读取转换，大文件下这条路径明显更慢，官方文档也建议大文件优先
            // 用 Uint8Array/ArrayBuffer。调用方需要 Blob(比如触发浏览器下载)时自己包一层。
            return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
        } finally {
            instance.off('progress', progressHandler);
            instance.off('log', logHandler);
            await instance.deleteFile(input).catch(() => {});
            await instance.deleteFile(output).catch(() => {});
        }
    }

    // ffmpeg-core 单个实例底层不可重入：两个任务同时 exec() 会互相踩虚拟文件系统/内存
    // 状态，表现就是随机的 ErrnoError。这里用一条 Promise 链强制串行化所有转码请求。
    let transcodeQueue = Promise.resolve();
    function enqueueTranscode(kind, arrayBuffer, onProgress) {
        const result = transcodeQueue.then(() => transcode(kind, arrayBuffer, onProgress));
        transcodeQueue = result.then(() => {}, () => {});
        return result;
    }

    // ==================================================================
    // 4. 通用工具：Token / 文件名 / 触发浏览器下载 / UI
    // ==================================================================

    function getAccessToken() {
        const storageStr = window.localStorage.getItem(STORAGE_KEY);
        if (!storageStr) return null;
        try {
            const firstParse = JSON.parse(storageStr);
            const secondParse = JSON.parse(firstParse.value);
            return secondParse.access_token || null;
        } catch (e) {
            return null;
        }
    }
    function buildAuthHeader(accessToken) {
        return `MAC id="${accessToken}",nonce="0",mac="0"`;
    }
    function sanitizeFileName(name) {
        return (name || 'download').trim().replace(/[\\/:*?"<>|]/g, '_');
    }
    function triggerBlobDownload(blob, fileName) {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    }

    function injectStyle() {
        if (document.getElementById('xedu-style')) return;
        const style = document.createElement('style');
        style.id = 'xedu-style';
        style.textContent = `
            .xedu-btn-group { display: inline-flex; gap: 8px; margin-left: 12px; vertical-align: middle; flex-wrap: wrap; }
            .xedu-btn-wrap { position: relative; display: inline-block; border-radius: 6px; overflow: hidden; vertical-align: middle; }
            .xedu-btn {
                display: block; padding: 6px 14px; background-color: #1890ff; color: #fff;
                border: none; font-size: 13px; font-weight: bold; cursor: pointer;
                box-shadow: 0 2px 8px rgba(0,0,0,0.15); transition: background-color 0.3s; white-space: nowrap;
            }
            .xedu-btn:hover { background-color: #40a9ff; }
            .xedu-btn:disabled { opacity: 0.7; cursor: default; }
            .xedu-btn.all { background-color: #52c41a; }
            .xedu-btn.all:hover { background-color: #73d13d; }
            .xedu-btn.video { background-color: #722ed1; }
            .xedu-btn.video:hover { background-color: #9254de; }
            .xedu-btn.muted { background-color: #999; cursor: default; }
            .xedu-btn.error { background-color: #f5222d; cursor: default; }
            .xedu-progress {
                position: absolute; left: 0; top: 0; height: 100%; width: 0%;
                background: rgba(0, 0, 0, 0.18);
                transition: width 0.2s ease; opacity: 0; pointer-events: none;
            }
            .xedu-progress.active { opacity: 1; }
            .xedu-progress.indeterminate { width: 40% !important; animation: xedu-indeterminate 1.1s infinite ease-in-out; }
            @keyframes xedu-indeterminate { 0% { left: -40%; } 100% { left: 100%; } }

            /* 悬浮展开的下拉菜单：默认只显示"全部打包下载"，hover后展开子项列表 */
            .xedu-dropdown-wrap { position: relative; display: inline-block; margin-left: 12px; vertical-align: middle; }
            .xedu-dropdown-menu {
                position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 10000;
                background: #fff; border-radius: 8px; padding: 4px; min-width: 168px;
                box-shadow: 0 6px 20px rgba(0,0,0,0.18);
                opacity: 0; visibility: hidden; transform: translateY(-6px);
                transition: opacity 0.15s ease, transform 0.15s ease, visibility 0.15s;
            }
            .xedu-dropdown-wrap:hover .xedu-dropdown-menu,
            .xedu-dropdown-menu:hover {
                opacity: 1; visibility: visible; transform: translateY(0);
            }
            .xedu-dropdown-item-wrap { position: relative; border-radius: 4px; overflow: hidden; margin-bottom: 2px; }
            .xedu-dropdown-item-wrap:last-child { margin-bottom: 0; }
            .xedu-dropdown-item {
                display: block; width: 100%; text-align: left; padding: 8px 12px;
                background: transparent; border: none; color: #333; font-size: 13px;
                cursor: pointer; white-space: nowrap; border-radius: 4px;
            }
            .xedu-dropdown-item:hover { background: #f0f5ff; color: #1890ff; }
            .xedu-dropdown-item:disabled { opacity: 0.6; cursor: default; }
            .xedu-dropdown-item.video { color: #722ed1; }
            .xedu-dropdown-item.video:hover { background: #f9f0ff; }

            /* 面包屑容器默认 overflow:hidden 会把下拉菜单裁掉，这里放开 */
            .course-act-breadcrumb .breadcrumb-container,
            .web-breadcrumb .fish-breadcrumb { overflow: unset !important; }
        `;
        document.head.appendChild(style);
    }
    function makeButton(container, label, extraClass) {
        const wrap = document.createElement('span');
        wrap.className = 'xedu-btn-wrap';
        const btn = document.createElement('button');
        btn.className = 'xedu-btn' + (extraClass ? ' ' + extraClass : '');
        btn.textContent = label;
        const progress = document.createElement('div');
        progress.className = 'xedu-progress';
        wrap.appendChild(btn);
        wrap.appendChild(progress);
        container.appendChild(wrap);
        return { wrap, btn, progress };
    }
    function setProgress(progress, percent) {
        // 有新的进度更新，说明这个进度条被新一轮下载复用了，之前排队等着重置它的
        // 定时器就该作废，不然会在新下载途中把它闪空。
        if (progress._resetTimer) { clearTimeout(progress._resetTimer); progress._resetTimer = null; }
        progress.classList.add('active');
        if (percent === null || percent === undefined) progress.classList.add('indeterminate');
        else { progress.classList.remove('indeterminate'); progress.style.width = percent + '%'; }
    }
    function resetProgress(progress) {
        progress.classList.remove('active', 'indeterminate');
        progress.style.width = '0%';
    }
    function scheduleProgressReset(progress) {
        if (progress._resetTimer) clearTimeout(progress._resetTimer);
        progress._resetTimer = setTimeout(() => {
            progress._resetTimer = null;
            resetProgress(progress);
        }, 400);
    }

    // 普通 fetch + 流式读取 + 进度（PDF用，不需要自定义header，CORS本身是开的）
    async function downloadWithProgress(url, fileName, onProgress) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const totalStr = resp.headers.get('Content-Length');
        const total = totalStr ? parseInt(totalStr, 10) : 0;
        let loaded = 0;
        const chunks = [];
        const reader = resp.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            onProgress(total ? Math.min(100, Math.round((loaded / total) * 100)) : null);
        }
        triggerBlobDownload(new Blob(chunks), fileName);
    }

    // ==================================================================
    // 5. m3u8 解析 + 视频下载解密（复刻 smartedu-dl-go 的密钥交换协议）
    // ==================================================================

    function parseAttributeList(str) {
        const attrs = {};
        const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
        let m;
        while ((m = re.exec(str))) attrs[m[1]] = m[2];
        return attrs;
    }
    function parseM3U8(text, baseUrl) {
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        const segments = [];
        let keyInfo = null;
        for (const line of lines) {
            if (line.startsWith('#EXT-X-KEY')) {
                const attrs = parseAttributeList(line.substring(line.indexOf(':') + 1));
                if (attrs.METHOD && attrs.METHOD !== 'NONE') {
                    keyInfo = {
                        method: attrs.METHOD,
                        uri: attrs.URI ? attrs.URI.replace(/^"|"$/g, '') : null,
                        iv: attrs.IV || null,
                    };
                }
            } else if (!line.startsWith('#')) {
                segments.push(line.startsWith('http') ? line : new URL(line, baseUrl).href);
            }
        }
        return { segments, keyInfo };
    }

    // 密钥交换：nonce -> sign=md5(nonce+keyId)[:16] -> 拿到ECB包装的key -> 解出真正的CBC key
    async function fetchDecryptionKey(keyUrl, authHeader) {
        const keyId = keyUrl.split('/').filter(Boolean).pop();
        const signsResp = await gmRequestJSON(`${keyUrl}/signs`, authHeader);
        const nonce = signsResp.nonce;
        const sign = md5(nonce + keyId).slice(0, 16);
        const keyDataResp = await gmRequestJSON(`${keyUrl}?nonce=${encodeURIComponent(nonce)}&sign=${encodeURIComponent(sign)}`, authHeader);
        const keyCipherBytes = base64ToBytes(keyDataResp.key);
        const signKeyBytes = new TextEncoder().encode(sign); // 16字节，ECB包装密钥
        const decrypted = aesEcbDecrypt(keyCipherBytes, signKeyBytes);
        return pkcs7Unpad(decrypted); // 真正给TS分片解密用的 AES-128 key
    }

    async function decryptSegmentCBC(arrayBuffer, keyBytes, ivBytes) {
        const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, cryptoKey, arrayBuffer);
        return new Uint8Array(decrypted);
    }

    // 下载并解密整段视频分片，onProgress(percent) 在下载阶段回调，返回原始 ts 的 Blob
    // (真正的容器转换在 transcode('video', ...) 那一步做)
    async function assembleVideoBlob(m3u8Url, accessToken, onProgress) {
        const authHeader = buildAuthHeader(accessToken);
        const m3u8Resp = await gmRequest(m3u8Url, { headers: { 'x-nd-auth': authHeader } });
        const { segments, keyInfo } = parseM3U8(m3u8Resp.responseText, m3u8Url);
        if (segments.length === 0) throw new Error('未解析到任何视频分片(ts)，可能m3u8格式有变化');

        let key = null;
        let iv = new Uint8Array(16);
        if (keyInfo && keyInfo.uri) {
            key = await fetchDecryptionKey(keyInfo.uri, authHeader);
            if (keyInfo.iv) iv = hexToBytes(keyInfo.iv);
            // 注意：如果m3u8没给IV，标准做法应使用分片序号做IV，这里简化为全零，
            // 实测中该平台的m3u8基本都会显式带IV，遇到没带的情况请反馈。
        }

        const results = new Array(segments.length);
        let completed = 0;
        const CONCURRENCY = 4;
        let nextIndex = 0;

        async function worker() {
            for (;;) {
                const i = nextIndex++;
                if (i >= segments.length) return;
                const buf = await gmRequestArrayBuffer(segments[i], authHeader);
                results[i] = key ? await decryptSegmentCBC(buf, key, iv) : new Uint8Array(buf);
                completed++;
                onProgress(Math.round((completed / segments.length) * 100));
            }
        }

        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segments.length) }, worker));

        return new Blob(results, { type: 'video/mp2t' });
    }

    // ==================================================================
    // 6. 教材PDF下载（原有逻辑）
    // ==================================================================

    function initTextbookButton() {
        if (document.getElementById('xedu-pdf-btn')) return;
        const container = document.querySelector('.breadcrumb-container');
        if (!container) return;

        injectStyle();
        const { btn, progress } = makeButton(container, '下载教程', 'all');
        btn.id = 'xedu-pdf-btn';
        btn.parentElement.style.marginLeft = '12px';

        btn.addEventListener('click', async () => {
            const originalText = btn.textContent;
            try {
                const pdfPlayer = document.querySelector('#pdfPlayerFirefox');
                if (!pdfPlayer || !pdfPlayer.src) { alert('未找到PDF播放器，请等待教材加载完毕。'); return; }
                const fileUrl = new URL(pdfPlayer.src).searchParams.get('file');
                if (!fileUrl) { alert('未能从播放器提取到 file 参数！'); return; }
                const accessToken = getAccessToken();
                if (!accessToken) { alert('未找到登录凭证(Token)，请确认您是否已登录！'); return; }
                const finalUrl = `${fileUrl}?accessToken=${accessToken}`;
                const fileName = sanitizeFileName(document.title || fileUrl.split('/').pop()) + '.pdf';

                btn.disabled = true;
                await downloadWithProgress(finalUrl, fileName, (percent) => {
                    setProgress(progress, percent);
                    btn.textContent = '下载中...';
                });
            } catch (error) {
                console.error('下载失败:', error);
                alert('下载失败，请按F12查看控制台。可能是登录状态失效或跨域限制(CORS)。');
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
                scheduleProgressReset(progress);
            }
        });
    }

    // ==================================================================
    // 7. 课时资源下载：课件 / 教学设计 / 学习任务单 / 课后练习(PDF)
    //    + 视频课程(m3u8解密自动转mp4) + 音频(ogg自动转mp3，未找到真实样例验证)
    //
    // 三套页面共用同一套注入逻辑(挂载点都是 .fish-breadcrumb)，区别只在于
    // "怎么拿到资源详情JSON"：
    //   - syncClassroom: zxx/ndrv2/national_lesson/resources/details/{activityId}.json
    //     relations.national_course_resource
    //   - jpk 精品课(jpk.basic.smartedu.cn): competitive/{courseType}/resources/{courseId}.json
    //     relations.course_resource
    //   - basic.smartedu.cn/qualityCourse: zxx/ndrv2/resources/{courseId}.json
    //     relations.course_resource
    // 三者都是一次性返回整门课(所有课时)的资源，统一展示全部课时，不按 classHourId
    // 过滤，靠 buildLessonTitleByIndex 给每一项加"第一课时"这样的前缀区分。
    // ==================================================================

    function getLessonContext() {
        const url = new URL(location.href);
        if (location.hostname === 'jpk.basic.smartedu.cn' && url.pathname.includes('/yearQualityCourse')) {
            const courseId = url.searchParams.get('courseId');
            const courseType = url.searchParams.get('courseType');
            if (!courseId || !courseType) return null;
            return { kind: 'jpk', key: `jpk|${courseId}|${courseType}`, courseId, courseType };
        }
        if (location.hostname === 'basic.smartedu.cn' && url.pathname.includes('/qualityCourse')) {
            const courseId = url.searchParams.get('courseId');
            if (!courseId) return null;
            return { kind: 'qualityCourse', key: `quality|${courseId}`, courseId };
        }
        if (url.pathname.includes('/syncClassroom/classActivity') || url.pathname.includes('/syncClassroom/prepare/detail')) {
            const activityId = url.searchParams.get('activityId') || url.searchParams.get('resourceId');
            if (!activityId) return null;
            return { kind: 'syncClassroom', key: `sync|${activityId}`, activityId };
        }
        return null;
    }

    // plain fetch() 默认没有任何超时，连接一旦卡住(不成功也不报错)会一直悬着。
    // AbortSignal.timeout() 到点强制中断，让 catch 能兜住继续走下一个镜像/报错，
    // 而不是让调用方一直卡在那不知道发生了什么。
    function fetchWithTimeout(url, ms, init) {
        return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    }

    async function fetchLessonDetail(activityId) {
        let lastErr;
        for (const server of API_SERVERS) {
            try {
                const resp = await fetchWithTimeout(`https://${server}.ykt.cbern.com.cn/zxx/ndrv2/national_lesson/resources/details/${activityId}.json`, 20000);
                if (resp.ok) return await resp.json();
                lastErr = new Error(`HTTP ${resp.status} from ${server}`);
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('所有接口地址均请求失败');
    }
    async function fetchJpkCourseDetail(courseId, courseType) {
        let lastErr;
        for (const server of API_SERVERS) {
            try {
                const resp = await fetchWithTimeout(`https://${server}.ykt.cbern.com.cn/competitive/${courseType}/resources/${courseId}.json`, 20000);
                if (resp.ok) return await resp.json();
                lastErr = new Error(`HTTP ${resp.status} from ${server}`);
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('所有接口地址均请求失败');
    }
    // basic.smartedu.cn/qualityCourse：同一门课的资源详情接口不带 courseType 这一段路径。
    async function fetchQualityCourseDetail(courseId) {
        let lastErr;
        for (const server of API_SERVERS) {
            try {
                const resp = await fetchWithTimeout(`https://${server}.ykt.cbern.com.cn/zxx/ndrv2/resources/${courseId}.json`, 20000);
                if (resp.ok) return await resp.json();
                lastErr = new Error(`HTTP ${resp.status} from ${server}`);
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('所有接口地址均请求失败');
    }
    function fetchResourceDetail(context) {
        if (context.kind === 'syncClassroom') return fetchLessonDetail(context.activityId);
        if (context.kind === 'jpk') return fetchJpkCourseDetail(context.courseId, context.courseType);
        if (context.kind === 'qualityCourse') return fetchQualityCourseDetail(context.courseId);
        throw new Error(`未知的页面类型: ${context.kind}`);
    }

    // 一个 activityId/courseId 下如果绑了多个课时(第一课时/第二课时...)，资源详情接口
    // 会把所有课时的资源合并在同一个数组里返回，靠 resource_structure.relations[].res_ref
    // (形如 "$.relations.xxx_course_resource[0,1,2,3,4]") 才能知道哪几个下标属于哪个课时。
    // 只有一个课时(或没有这个字段)时返回 null，表示不需要加前缀区分。
    function buildLessonTitleByIndex(detail) {
        const relations = detail.resource_structure && Array.isArray(detail.resource_structure.relations)
            ? detail.resource_structure.relations
            : [];
        if (relations.length <= 1) return null;
        const map = new Map();
        for (const lesson of relations) {
            const resRef = Array.isArray(lesson.res_ref) && lesson.res_ref[0];
            const indexMatch = resRef && resRef.match(/\[([0-9,]+)\]/);
            if (!indexMatch) continue;
            for (const idxStr of indexMatch[1].split(',')) {
                map.set(Number(idxStr), lesson.title || lesson.id);
            }
        }
        return map.size > 0 ? map : null;
    }

    // 从详情JSON里挑出可下载资源：pdf > 视频(m3u8) > 音频(ogg，注：未能找到真实样例验证，
    // 按同样的 ti_format 探测模式实现，若实际遇到该资源类型请反馈)。
    // 多课时的话 lessonPrefix/baseLabel 分开保留，方便下拉菜单排版成
    // "第一课时 - 下载视频课程"，label(拼接后的完整字符串)则用于文件名。
    function extractDownloadableItems(detail) {
        const list = (detail.relations && (detail.relations.national_course_resource || detail.relations.course_resource)) || [];
        const lessonTitleByIndex = buildLessonTitleByIndex(detail);
        return list
            .map((item, index) => {
                const lessonPrefix = lessonTitleByIndex && lessonTitleByIndex.has(index) ? lessonTitleByIndex.get(index) : '';
                const baseLabel = item.title || item.resource_type_code_name || item.resource_type_code;
                const label = lessonPrefix + baseLabel;
                const tiItems = item.ti_items || [];

                const pdfTi = tiItems.find((ti) => ti.ti_format === 'pdf');
                if (pdfTi) return { id: item.id, label, lessonPrefix, baseLabel, kind: 'pdf', storages: pdfTi.ti_storages };

                const videoTis = tiItems.filter((ti) => ti.ti_format === 'm3u8');
                if (videoTis.length > 0) {
                    const preferred = videoTis.find((ti) => ti.ti_file_flag === 'href-m3u8') || videoTis[videoTis.length - 1];
                    return { id: item.id, label, lessonPrefix, baseLabel, kind: 'video', storages: preferred.ti_storages };
                }

                const audioTi = tiItems.find((ti) => ti.ti_format === 'ogg');
                if (audioTi) return { id: item.id, label, lessonPrefix, baseLabel, kind: 'audio', storages: audioTi.ti_storages };

                return null;
            })
            .filter(Boolean);
    }

    // 单项下载：pdf 直接流式下载；video 解密 ts 后用 ffmpeg 转 mp4；
    // audio 直接下载 ogg 后用 ffmpeg 转 mp3。完成后都是浏览器原生的一次 blob 下载。
    async function downloadItem(courseTitle, item, btn, progress) {
        const accessToken = getAccessToken();
        if (!accessToken) { alert('未找到登录凭证(Token)，请确认您是否已登录！'); throw new Error('no access token'); }

        const originalText = btn.textContent;
        btn.disabled = true;
        try {
            if (item.kind === 'pdf') {
                let lastErr;
                for (const base of item.storages) {
                    try {
                        const finalUrl = `${base}?accessToken=${accessToken}`;
                        const fileName = `${courseTitle}_${item.label}.pdf`;
                        await downloadWithProgress(finalUrl, fileName, (percent) => {
                            setProgress(progress, percent);
                            btn.textContent = '下载中...';
                        });
                        return;
                    } catch (e) { lastErr = e; }
                }
                throw lastErr || new Error('所有镜像地址均下载失败');
            }

            if (item.kind === 'video') {
                let lastErr;
                for (const base of item.storages) {
                    try {
                        const fileName = `${courseTitle}_${item.label}.mp4`;
                        setProgress(progress, 0);
                        btn.textContent = '下载中...';
                        const tsBlob = await assembleVideoBlob(base, accessToken, (percent) => {
                            // 下载解密占70%，转码占30%
                            setProgress(progress, Math.round(percent * 0.7));
                        });
                        const tsBuffer = await tsBlob.arrayBuffer();
                        const mp4Bytes = await enqueueTranscode('video', tsBuffer, (percent) => {
                            setProgress(progress, 70 + Math.round(percent * 0.3));
                        });
                        triggerBlobDownload(new Blob([mp4Bytes], { type: 'video/mp4' }), fileName);
                        return;
                    } catch (e) { lastErr = e; }
                }
                throw lastErr || new Error('所有镜像地址均下载失败');
            }

            if (item.kind === 'audio') {
                let lastErr;
                for (const base of item.storages) {
                    try {
                        const fileName = `${courseTitle}_${item.label}.mp3`;
                        setProgress(progress, null);
                        btn.textContent = '下载中...';
                        const resp = await fetchWithTimeout(`${base}?accessToken=${accessToken}`, 60000);
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        const oggBuffer = await resp.arrayBuffer();
                        const mp3Bytes = await enqueueTranscode('audio', oggBuffer, (percent) => {
                            setProgress(progress, percent);
                        });
                        triggerBlobDownload(new Blob([mp3Bytes], { type: 'audio/mpeg' }), fileName);
                        return;
                    } catch (e) { lastErr = e; }
                }
                throw lastErr || new Error('所有镜像地址均下载失败');
            }
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
            scheduleProgressReset(progress);
        }
    }

    // "全部打包下载"：逐个处理 items，成功的塞进同一个 JSZip 实例，最后统一生成一个
    // zip 触发下载。单项失败不影响其它项，只有全部失败时才整体报错；有部分失败会在
    // 完成后弹窗列出来。
    async function downloadAllAsZip(courseTitle, items, mainBtn, mainProgress) {
        const accessToken = getAccessToken();
        if (!accessToken) { alert('未找到登录凭证(Token)，请确认您是否已登录！'); return; }

        mainBtn.disabled = true;
        const originalText = mainBtn.textContent;
        mainBtn.textContent = '打包中...';
        const failedItems = [];
        try {
            const zip = new JSZip();
            let addedCount = 0;
            const perItemWeight = 90 / items.length;

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const baseProgress = Math.round(i * perItemWeight);
                const reportItemProgress = (percent) => {
                    setProgress(mainProgress, baseProgress + Math.round((percent / 100) * perItemWeight));
                    mainBtn.textContent = '打包中...';
                };
                let added = false;
                let lastErr;

                // 包一层 try/catch：不光是网络请求失败，storages 不是数组这类意外情况
                // 也要按"这一项失败"处理，不能让它把整个打包任务带崩。
                try {
                    if (item.kind === 'pdf') {
                        for (const base of item.storages) {
                            try {
                                const resp = await fetchWithTimeout(`${base}?accessToken=${accessToken}`, 60000);
                                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                                // JSZip 处理 Blob 类型内容要经过额外异步读取转换，大文件下明显更慢，
                                // 官方文档建议优先用 Uint8Array/ArrayBuffer(下面几处同理)。
                                const pdfBytes = new Uint8Array(await resp.arrayBuffer());
                                zip.file(sanitizeFileName(`${item.label}.pdf`), pdfBytes);
                                reportItemProgress(100);
                                added = true;
                                break;
                            } catch (e) { lastErr = e; }
                        }
                    } else if (item.kind === 'video') {
                        for (const base of item.storages) {
                            try {
                                const tsBlob = await assembleVideoBlob(base, accessToken, (percent) => reportItemProgress(Math.round(percent * 0.6)));
                                const tsBuffer = await tsBlob.arrayBuffer();
                                const mp4Bytes = await enqueueTranscode('video', tsBuffer, (percent) => reportItemProgress(60 + Math.round(percent * 0.4)));
                                zip.file(sanitizeFileName(`${item.label}.mp4`), mp4Bytes);
                                added = true;
                                break;
                            } catch (e) { lastErr = e; }
                        }
                    } else if (item.kind === 'audio') {
                        for (const base of item.storages) {
                            try {
                                const resp = await fetchWithTimeout(`${base}?accessToken=${accessToken}`, 60000);
                                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                                const oggBuffer = await resp.arrayBuffer();
                                const mp3Bytes = await enqueueTranscode('audio', oggBuffer, reportItemProgress);
                                zip.file(sanitizeFileName(`${item.label}.mp3`), mp3Bytes);
                                added = true;
                                break;
                            } catch (e) { lastErr = e; }
                        }
                    }
                } catch (e) { lastErr = e; }

                if (added) {
                    addedCount++;
                } else {
                    console.error(`打包zip: "${item.label}" 处理失败，已跳过`, lastErr);
                    failedItems.push(item.label);
                }
            }

            if (addedCount === 0) throw new Error('所有资源都处理失败，无法打包(详情见控制台)');

            const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (metadata) => {
                setProgress(mainProgress, 90 + Math.round(metadata.percent * 0.1));
                mainBtn.textContent = '打包中...';
            });
            triggerBlobDownload(zipBlob, `${sanitizeFileName(courseTitle)}.zip`);

            if (failedItems.length > 0) {
                alert(`打包完成，但以下 ${failedItems.length} 项下载失败，已跳过：\n${failedItems.join('\n')}`);
            }
        } catch (err) {
            console.error('打包下载全部失败:', err);
            alert('打包下载失败，请按F12查看控制台。可能是登录状态失效。');
        } finally {
            mainBtn.textContent = originalText;
            mainBtn.disabled = false;
            scheduleProgressReset(mainProgress);
        }
    }

    // jpk/qualityCourse 页面切换"第一课时/第二课时"标签是SPA内切换，不一定重新挂载
    // .fish-breadcrumb，所以要记录当前课程的key，变化时主动重建按钮组。
    let currentLessonKey = null;

    function initLessonButtons(context) {
        const existing = document.getElementById('xedu-lesson-btns');
        if (existing) {
            if (currentLessonKey === context.key) return;
            existing.remove();
        }
        currentLessonKey = context.key;

        const container = document.querySelector('.fish-breadcrumb');
        if (!container) return;

        injectStyle();

        const wrap = document.createElement('span');
        wrap.id = 'xedu-lesson-btns';
        wrap.className = 'xedu-dropdown-wrap';
        container.appendChild(wrap);

        const { btn: mainBtn, progress: mainProgress } = makeButton(wrap, '加载资源中...', 'muted');
        mainBtn.disabled = true;

        const menu = document.createElement('div');
        menu.className = 'xedu-dropdown-menu';
        wrap.appendChild(menu);

        function makeDropdownItem(label, extraClass) {
            const itemWrap = document.createElement('div');
            itemWrap.className = 'xedu-dropdown-item-wrap';
            const itemBtn = document.createElement('button');
            itemBtn.className = 'xedu-dropdown-item' + (extraClass ? ' ' + extraClass : '');
            itemBtn.textContent = label;
            const itemProgress = document.createElement('div');
            itemProgress.className = 'xedu-progress';
            itemWrap.appendChild(itemBtn);
            itemWrap.appendChild(itemProgress);
            menu.appendChild(itemWrap);
            return { btn: itemBtn, progress: itemProgress };
        }

        fetchResourceDetail(context)
            .then((detail) => {
                const items = extractDownloadableItems(detail);

                if (items.length === 0) {
                    mainBtn.textContent = '无可下载资源';
                    mainBtn.classList.add('muted');
                    return;
                }

                const courseTitle = sanitizeFileName(detail.title || document.title);

                items.forEach((item) => {
                    const isMedia = item.kind === 'video' || item.kind === 'audio';
                    const buttonText = item.lessonPrefix ? `${item.lessonPrefix} - 下载${item.baseLabel}` : `下载${item.baseLabel}`;
                    const { btn, progress } = makeDropdownItem(buttonText, isMedia ? 'video' : '');
                    btn.addEventListener('click', () => {
                        downloadItem(courseTitle, item, btn, progress).catch((err) => {
                            console.error(`${item.label} 下载失败:`, err);
                            alert(`${item.label} 下载失败，请按F12查看控制台。可能是登录状态失效、跨域限制或m3u8格式变化。`);
                        });
                    });
                });

                mainBtn.textContent = `全部打包下载(${items.length})`;
                mainBtn.classList.remove('muted');
                mainBtn.classList.add('all');
                mainBtn.disabled = false;

                mainBtn.addEventListener('click', () => {
                    downloadAllAsZip(courseTitle, items, mainBtn, mainProgress);
                });
            })
            .catch((err) => {
                console.error('获取课时资源详情失败:', err);
                mainBtn.textContent = '资源加载失败(见控制台)';
                mainBtn.classList.remove('all', 'muted');
                mainBtn.classList.add('error');
                mainBtn.disabled = true;
            });
    }

    // ==================================================================
    // 8. 路由轮询（SPA不刷新页面，靠URL变化判断当前显示哪套按钮）
    // ==================================================================

    setInterval(() => {
        if (location.href.includes('/tchMaterial/detail')) {
            initTextbookButton();
        } else {
            const btn = document.getElementById('xedu-pdf-btn');
            if (btn) btn.closest('.xedu-btn-wrap')?.remove();
        }

        const context = getLessonContext();
        if (context) {
            initLessonButtons(context);
        } else {
            const group = document.getElementById('xedu-lesson-btns');
            if (group) group.remove();
            currentLessonKey = null;
        }
    }, 1000);
})();
