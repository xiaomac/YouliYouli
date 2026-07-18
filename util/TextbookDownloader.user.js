// ==UserScript==
// @name         SmartEDU - TextbookDownloader
// @version      0.1
// @description  在教材详情页面包屑栏追加一个按钮，提取当前教材的PDF直链并带上Token直接下载，按钮底部显示下载进度条。
// @author       xiaomac
// @match        https://basic.smartedu.cn/tchMaterial/detail*
// @icon         https://basic.smartedu.cn/favicon.ico
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/xiaomac/YouliYouli/main/util/TextbookDownloader.user.js
// @updateURL    https://raw.githubusercontent.com/xiaomac/YouliYouli/main/util/TextbookDownloader.user.js
// ==/UserScript==
(function () {
    'use strict';

    // 注入进度条动画所需的 CSS（仅注入一次）
    function injectStyle() {
        if (document.getElementById('xedu-pdf-style')) return;
        const style = document.createElement('style');
        style.id = 'xedu-pdf-style';
        style.textContent = `
            #xedu-pdf-wrap {
                position: relative;
                display: inline-block;
                margin-left: 12px;
                vertical-align: middle;
                border-radius: 6px;
                overflow: hidden;
            }
            #xedu-pdf-progress {
                position: absolute;
                left: 0;
                bottom: 0;
                height: 3px;
                width: 0%;
                background: #52c41a;
                transition: width 0.15s ease;
                opacity: 0;
            }
            #xedu-pdf-progress.active {
                opacity: 1;
            }
            #xedu-pdf-progress.indeterminate {
                width: 40% !important;
                animation: xedu-indeterminate 1.1s infinite ease-in-out;
            }
            @keyframes xedu-indeterminate {
                0%   { left: -40%; }
                100% { left: 100%; }
            }
        `;
        document.head.appendChild(style);
    }

    function initButton() {
        if (document.getElementById('xedu-pdf-btn')) return;

        const container = document.querySelector('.breadcrumb-container');
        if (!container) return;

        injectStyle();

        const wrap = document.createElement('span');
        wrap.id = 'xedu-pdf-wrap';

        const btn = document.createElement('button');
        btn.id = 'xedu-pdf-btn';
        btn.textContent = '下载PDF';
        btn.style.display = 'block';
        btn.style.padding = '6px 16px';
        btn.style.backgroundColor = '#1890ff';
        btn.style.color = 'white';
        btn.style.border = 'none';
        btn.style.fontSize = '13px';
        btn.style.fontWeight = 'bold';
        btn.style.cursor = 'pointer';
        btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
        btn.style.transition = 'background-color 0.3s';
        btn.onmouseover = () => btn.style.backgroundColor = '#40a9ff';
        btn.onmouseout = () => btn.style.backgroundColor = '#1890ff';

        const progress = document.createElement('div');
        progress.id = 'xedu-pdf-progress';

        wrap.appendChild(btn);
        wrap.appendChild(progress);

        function setProgress(percent) {
            progress.classList.remove('indeterminate');
            progress.classList.add('active');
            progress.style.width = percent + '%';
        }

        function setIndeterminate() {
            progress.classList.add('active', 'indeterminate');
        }

        function resetProgress() {
            progress.classList.remove('active', 'indeterminate');
            progress.style.width = '0%';
        }

        btn.addEventListener('click', async () => {
            const originalText = btn.textContent;
            try {
                const pdfPlayer = document.querySelector("#pdfPlayerFirefox");
                if (!pdfPlayer || !pdfPlayer.src) {
                    alert("未找到PDF播放器，请等待教材加载完毕。");
                    return;
                }

                const fileUrl = new URL(pdfPlayer.src).searchParams.get("file");
                if (!fileUrl) {
                    alert("未能从播放器提取到 file 参数！");
                    return;
                }

                const storageKey = "ND_UC_AUTH-e5649925-441d-4a53-b525-51a2f1c4e0a8&ncet-xedu&token";
                const storageStr = window.localStorage.getItem(storageKey);
                if (!storageStr) {
                    alert("未找到登录凭证(Token)，请确认您是否已登录！");
                    return;
                }

                const firstParse = JSON.parse(storageStr);
                const secondParse = JSON.parse(firstParse.value);
                const accessToken = secondParse.access_token;

                const finalUrl = `${fileUrl}?accessToken=${accessToken}`;
                const fileName = (document.title || fileUrl.split('/').pop()).trim().replace(/[\\/:*?"<>|]/g, '_') + '.pdf';

                btn.disabled = true;
                btn.textContent = '下载中 0%';

                const resp = await fetch(finalUrl);
                if (!resp.ok) {
                    throw new Error(`HTTP ${resp.status}`);
                }

                const totalStr = resp.headers.get('Content-Length');
                const total = totalStr ? parseInt(totalStr, 10) : 0;

                let loaded = 0;
                const chunks = [];
                const reader = resp.body.getReader();

                if (!total) {
                    setIndeterminate();
                }

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                    loaded += value.length;
                    if (total) {
                        const percent = Math.min(100, Math.round((loaded / total) * 100));
                        setProgress(percent);
                        btn.textContent = `下载中 ${percent}%`;
                    } else {
                        btn.textContent = `下载中 ${(loaded / 1024 / 1024).toFixed(1)}MB`;
                    }
                }

                const blob = new Blob(chunks);
                const blobUrl = URL.createObjectURL(blob);

                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = fileName;
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(blobUrl);

            } catch (error) {
                console.error("下载失败:", error);
                alert("下载失败，请按F12打开控制台查看具体报错信息。可能是登录状态失效或跨域限制(CORS)。");
            } finally {
                btn.textContent = originalText;
                btn.disabled = false;
                setTimeout(resetProgress, 400);
            }
        });

        container.appendChild(wrap);
    }

    setInterval(() => {
        if (location.href.includes('/tchMaterial/detail')) {
            initButton();
        } else {
            const wrap = document.getElementById('xedu-pdf-wrap');
            if (wrap) wrap.remove();
        }
    }, 1000);
})();