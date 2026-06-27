// 1. 将 inject.js 注入到真实页面中
const script = document.createElement('script');
script.src = chrome.runtime.getURL('inject.js');
(document.head || document.documentElement).appendChild(script);
script.onload = () => script.remove();

// 状态全局锁
let hasRenderedSummary = false;
let hasRenderedShop = false;
let lastProductId = null;
let hasRenderedDescription = false; 
let currentProductUrl = window.location.pathname;

// 记录当前捕获到的总评价条数，用来判断是否有新数据进入
let capturedCommentsCount = 0;

// 动态汇率逻辑
let MYR_TO_CNY_RATE = 1.66; 
async function fetchLiveExchangeRate() {
    try {
        const response = await fetch('https://open.er-api.com/v6/latest/MYR');
        const data = await response.json();
        if (data && data.rates && data.rates.CNY) {
            MYR_TO_CNY_RATE = parseFloat(data.rates.CNY);
            console.log(`[中文翻译助手] 最新实时汇率：1 MYR = ${MYR_TO_CNY_RATE} CNY`);
        }
    } catch (error) {
        console.error('[中文翻译助手] 汇率拉取失败，启用保底汇率 1.66:', error);
    }
}
fetchLiveExchangeRate();

// DOM 抓取函数组
function getProductTitle() {
    const titleEl = document.querySelector('h1');
    return titleEl ? titleEl.innerText.trim() : "";
}

function getProductPriceText() {
    const priceEl = document.querySelector('.IZPeQz');
    return priceEl ? priceEl.innerText.trim() : "";
}

// 【绝对去重版】：解决网页双节点导致文本出现两遍的问题
function getProductDescription() {
    const headings = Array.from(document.querySelectorAll('h2'));
    const descHeading = headings.find(h => 
        h.innerText.includes('商品描述') || 
        h.innerText.toLowerCase().includes('product description') ||
        h.innerText.toLowerCase().includes('description')
    );
    
    if (!descHeading) return "";
    
    const contentContainer = descHeading.nextElementSibling || descHeading.parentElement.querySelector('div');
    if (!contentContainer) return "";
    
    const textElements = Array.from(contentContainer.querySelectorAll('p, span, div'));
    
    let allLines = [];
    textElements.forEach(el => {
        let text = el.innerText ? el.innerText.trim() : "";
        if (text) {
            let lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            allLines = allLines.concat(lines);
        }
    });
    
    // 行级绝对严格去重，剃除隐藏的响应式双容器导致的重复段落
    const uniqueLines = [...new Set(allLines)];
    return uniqueLines.join('\n');
}

function parseAndConvertCnyText(myrStr) {
    if (!myrStr) return '未获取到原价格';
    let cleanStr = myrStr.replace(/RM|\$|,/gi, '').trim();
    
    if (cleanStr.includes('-')) {
        let parts = cleanStr.split('-');
        let cnyParts = parts.map(p => {
            let num = parseFloat(p.trim());
            return isNaN(num) ? null : (num * MYR_TO_CNY_RATE).toFixed(2);
        });
        if (cnyParts[0] && cnyParts[1]) {
            return `¥${cnyParts[0]} - ¥${cnyParts[1]}`;
        }
    } else {
        let num = parseFloat(cleanStr);
        if (!isNaN(num)) {
            return `¥${(num * MYR_TO_CNY_RATE).toFixed(2)}`;
        }
    }
    return '价格解析失败';
}

function refreshPriceCardData() {
    const cnyPriceValEl = document.getElementById('shopee-cny-price-val');
    const rateInfoEl = document.getElementById('shopee-exchange-rate-info');
    
    if (!cnyPriceValEl || !rateInfoEl) return;

    const rawPriceText = getProductPriceText();
    const convertedCnyText = parseAndConvertCnyText(rawPriceText);

    cnyPriceValEl.innerText = convertedCnyText;
    rateInfoEl.innerText = `原价: ${rawPriceText || '--'} | 汇率: 1 MYR ≈ ${MYR_TO_CNY_RATE.toFixed(4)} CNY`;
}

// 提取并智能加载详情翻译
async function triggerDetailTranslationFlow() {
    if (hasRenderedDescription) return;

    const titleArea = document.getElementById('shopee-translated-title');
    const descArea = document.getElementById('shopee-translated-desc-content');
    if (!titleArea || !descArea) return;
    
    const rawTitle = getProductTitle();
    const rawDesc = getProductDescription();

    if (!rawDesc) {
        titleArea.innerHTML = rawTitle ? `<span class="translated-title-text">📌 ${rawTitle}</span>` : "等待抓取...";
        descArea.innerHTML = `<span style="color:#ff4d4f; font-size:12px; display:block; padding:5px;">⚠️ 未捕获到内容。<br>温馨提示：请向下滑动页面加载完“商品描述”模块后，系统将自动翻译呈现。</span>`;
        return;
    }

    hasRenderedDescription = true;
    titleArea.innerHTML = `<span style="color:#666;">抓取标题中...</span>`;
    descArea.innerHTML = `<div id="desc-loading-spinner" style="text-align:center;color:#198754;padding-top:15px;">连接翻译引擎中...</div>`;
    
    if (rawTitle) {
        translateToChinese(rawTitle).then(transTitle => {
            titleArea.innerHTML = `<span class="translated-title-text">🇨🇳 ${transTitle}</span>`;
        }).catch(() => { titleArea.innerText = "❌ 标题翻译失败"; });
    }

    try {
        const result = await translateToChinese(rawDesc);
        descArea.innerHTML = result.replace(/\n/g, '<br>');
    } catch (err) {
        descArea.innerHTML = `<span style="color:#ff4d4f;">❌ 翻译生成异常，请点击右侧浮窗重试。</span>`;
        hasRenderedDescription = false;
    }
}

// 初始化右侧主悬浮框架（重组：默认展示详情描述）
function initSidebar() {
    let sidebar = document.getElementById('shopee-translator-sidebar');
    if (sidebar) return;

    sidebar = document.createElement('div');
    sidebar.id = 'shopee-translator-sidebar';
    sidebar.innerHTML = `
        <div class="sidebar-header">
            <h3>🇨🇳 商品中文详情与换算</h3>
            <span class="close-btn" id="shopee-sidebar-close-btn">×</span>
        </div>
        
        <div id="shopee-main-detail-content">
            <div class="detail-scroll-body">
                <div class="slide-price-card">
                    <div class="price-row">
                        <span class="cny-label">🇨🇳 折合人民币</span>
                        <span id="shopee-cny-price-val" class="cny-value">计算中...</span>
                    </div>
                    <div id="shopee-exchange-rate-info" class="rate-info">当前实时汇率换算中...</div>
                </div>

                <div class="translated-title-box">
                    <strong>📌 商品标题翻译</strong>
                    <div id="shopee-translated-title" style="color: #888;">正在获取数据...</div>
                </div>
                
                <div class="desc-divider">详细描述</div>
                <div id="shopee-translated-desc-content" style="color: #666;">等待提取页面内容...</div>
            </div>
            
            <button class="switch-to-reviews-btn" id="shopee-go-reviews-btn">查看买家评价翻译 →</button>
        </div>

        <div id="shopee-reviews-slide-panel" class="slide-panel">
            <div class="panel-header">
                <h3>⭐ 买家评价精选翻译</h3>
                <span class="close-panel-btn" id="shopee-close-reviews-btn">← 返回详情</span>
            </div>
            <div id="ratings-summary-container"></div>
            <div id="comment-list-container">
                <p class="placeholder-tip">等待滚动到评价区捕获有效数据...</p>
            </div>
        </div>
    `;
    document.body.appendChild(sidebar);

    // 迷你悬浮标
    const miniBtn = document.createElement('div');
    miniBtn.id = 'shopee-translator-mini-btn';
    miniBtn.innerHTML = `<div>中</div><div>文</div><div>翻</div><div>译</div>`;
    document.body.appendChild(miniBtn);

    // 事件绑定组
    document.getElementById('shopee-sidebar-close-btn').addEventListener('click', () => {
        sidebar.style.display = 'none';
        miniBtn.style.display = 'flex';
    });

    miniBtn.addEventListener('click', () => {
        sidebar.style.display = 'flex';
        miniBtn.style.display = 'none';
        refreshPriceCardData();
        if (!hasRenderedDescription) triggerDetailTranslationFlow();
    });

    // 关键核心：第二次点击打开“评价翻译”面板
    document.getElementById('shopee-go-reviews-btn').addEventListener('click', () => {
        document.getElementById('shopee-reviews-slide-panel').classList.add('show');
    });

    // 从评价翻译面板返回详情面板
    document.getElementById('shopee-close-reviews-btn').addEventListener('click', () => {
        document.getElementById('shopee-reviews-slide-panel').classList.remove('show');
    });
}

if (document.body) {
    initSidebar();
} else {
    window.addEventListener('DOMContentLoaded', initSidebar);
}

// 谷歌核心翻译函数
async function translateToChinese(text) {
    if (!text || text.trim() === "") return "";
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
        const res = await fetch(url);
        const json = await res.json();
        return json[0].map(item => item[0]).join('');
    } catch (e) { return text + " (翻译失败)"; }
}

function formatShopValue(valStr) {
    if (!valStr) return '';
    let trimmed = valStr.trim();
    if (/m$/i.test(trimmed)) {
        let num = parseFloat(trimmed);
        if (!isNaN(num)) return (num * 100).toFixed(0) + '万';
    }
    return trimmed;
}

// 4. 高频定时器自动化轮询渲染
setInterval(() => {
    initSidebar();
    
    // URL 单页应用切换监测
    if (currentProductUrl !== window.location.pathname) {
        currentProductUrl = window.location.pathname;
        hasRenderedSummary = false;
        hasRenderedShop = false;
        hasRenderedDescription = false; 
        const descArea = document.getElementById('shopee-translated-desc-content');
        if (descArea) descArea.innerText = "切换商品，等待重新提取...";
    }

    // 只要大窗口亮起，就持续维持顶部最新价格的追踪与刷新
    const sidebar = document.getElementById('shopee-translator-sidebar');
    if (sidebar && sidebar.style.display !== 'none') {
        refreshPriceCardData();
        if (!hasRenderedDescription) {
            triggerDetailTranslationFlow();
        }
    }

    // 处理二级评级模块 DOM
    const summaryContainer = document.getElementById('ratings-summary-container');
    if (!summaryContainer) return;

    const scoreEl = document.querySelector('.product-rating-overview__rating-score');
    const filterEls = document.querySelectorAll('.product-rating-overview__filters .product-rating-overview__filter span');
    const shopDetailItems = document.querySelectorAll('.NGzCXN .YnZi6x');

    if (!scoreEl && !shopDetailItems.length) {
        hasRenderedSummary = false;
        hasRenderedShop = false;
        return;
    }

    if (scoreEl && filterEls.length > 0 && !hasRenderedSummary) {
        const score = scoreEl.innerText.trim();
        let tagsHtml = '';
        filterEls.forEach((el) => {
            const isElActive = el.parentElement.classList.contains('product-rating-overview__filter--active') ? 'active' : '';
            tagsHtml += `<span class="summary-tag ${isElActive}">${el.innerText.trim()}</span>`;
        });

        let overviewBox = summaryContainer.querySelector('.sidebar-overview-module');
        if (!overviewBox) {
            overviewBox = document.createElement('div');
            overviewBox.className = 'sidebar-overview-module';
            summaryContainer.appendChild(overviewBox);
        }
        overviewBox.innerHTML = `
            <div class="summary-score-box">
                <span class="big-score">${score}</span><span class="score-max">/5</span>
                <div class="mini-stars">⭐⭐⭐⭐微</div>
            </div>
            <div class="summary-tags-grid">${tagsHtml}</div>
        `;
        hasRenderedSummary = true;
    }

    if (shopDetailItems.length > 0 && !hasRenderedShop) {
        let shopHtml = `<div class="sidebar-shop-title">商家详情</div><div class="shop-info-grid">`;
        shopDetailItems.forEach(item => {
            const label = item.querySelector('.ffHYws')?.innerText.trim() || '';
            let value = item.querySelector('.Cs6w3G')?.innerText.trim() || '';
            value = formatShopValue(value);
            if (label) {
                shopHtml += `<div class="shop-info-item"><label>${label}:</label> <span>${value}</span></div>`;
            }
        });
        shopHtml += '</div>';

        let shopBox = summaryContainer.querySelector('.sidebar-shop-module');
        if (!shopBox) {
            shopBox = document.createElement('div');
            shopBox.className = 'sidebar-shop-module';
            summaryContainer.appendChild(shopBox);
        }
        shopBox.innerHTML = shopHtml;
        hasRenderedShop = true;
    }
}, 1000);

// 5. 抓取并解析后台实时网络评价流（加入自动分页，剔除强制滚动）
window.addEventListener('SHOPEE_RATINGS_CAPTURED', async (event) => {
    const resData = event.detail;
    if (!resData || !resData.data || !resData.data.ratings) return;

    const ratings = resData.data.ratings;
    initSidebar();
    
    const container = document.getElementById('comment-list-container');
    if (!container) return;

    const firstItem = ratings[0];
    // 如果切换了商品，清空列表和计数
    if (firstItem && firstItem.itemid !== lastProductId) {
        lastProductId = firstItem.itemid;
        container.innerHTML = ''; 
        capturedCommentsCount = 0;
    }

    for (let item of ratings) {
        let originalText = item.comment ? item.comment.trim() : "";
        if (!originalText && item.low_rating_reasons?.[0]?.low_rating_reasons?.[0]) {
            const tagObj = item.low_rating_reasons[0].low_rating_reasons[0];
            originalText = `[买家标签]: ${tagObj.tag_name_tr || tagObj.tag_name || "差评标签"}`;
        }

        const hasImages = item.images && item.images.length > 0;
        const hasVideos = item.videos && item.videos.length > 0;
        if (!originalText && !hasImages && !hasVideos) continue;

        if (container.querySelector('.placeholder-tip')) container.innerHTML = '';

        const username = item.author_username || "匿名买家";
        const star = "⭐".repeat(item.rating_star);
        const modelName = item.product_items?.[0]?.model_name || "未选规格";

        let mediaHtml = '';
        if (hasImages || hasVideos) {
            mediaHtml = '<div class="comment-images-wrapper">';
            if (hasVideos) {
                item.videos.forEach(vid => {
                    const videoUrl = vid.url || (vid.video_id ? `https://cv.shopee.com.my/file/${vid.video_id}` : null);
                    if (videoUrl) {
                        mediaHtml += `<div class="comment-video-box"><video src="${videoUrl}" class="comment-video-item" controls preload="metadata"></video></div>`;
                    }
                });
            }
            if (hasImages) {
                item.images.forEach(imgId => {
                    mediaHtml += `<img src="https://down-ws-global.img.susercontent.com/file/${imgId}" class="comment-img-item" alt="晒图" onerror="this.src='https://cf.shopee.com.my/file/${imgId}'" />`;
                });
            }
            mediaHtml += '</div>';
        }

        const commentBox = document.createElement('div');
        commentBox.className = 'comment-item-box';
        commentBox.innerHTML = `
            <div class="comment-meta">
                <strong>${username}</strong> <span class="comment-star">${star}</span>
                <span class="comment-model">规格: ${modelName}</span>
            </div>
            <div class="comment-text-trans">${originalText ? "正在翻译..." : "[买家仅提供多媒体晒单]"}</div>
            ${mediaHtml}
        `;
        container.appendChild(commentBox);
        capturedCommentsCount++; // 计数增加

        if (originalText) {
            translateToChinese(originalText).then(translatedText => {
                commentBox.querySelector('.comment-text-trans').innerText = `🇨🇳 ${translatedText}`;
                // 【核心修正】：删除了原有强行修改 container.scrollTop 的行，绝不干扰用户当前的滚动视线
            });
        }
    }

    // 移除旧加载提示，重新在最底部追加一个用于触发自动分页的提示标
    const oldLoader = document.getElementById('shopee-infinite-load-tip');
    if (oldLoader) oldLoader.remove();

    const loadTip = document.createElement('div');
    loadTip.id = 'shopee-infinite-load-tip';
    loadTip.style = 'text-align:center; color:#999; font-size:11px; padding:15px 0; border-top:1px dashed #eee;';
    loadTip.innerText = `已加载 ${capturedCommentsCount} 条评价。向下滚动自动加载更多...`;
    container.appendChild(loadTip);
});

// 【核心新增】：监听插件内评价列表的滚动事件
// 当用户在插件里把评价列表滚到底部时，自动帮用户去点击原网页的“下一页”
document.addEventListener('scroll', (e) => {
    const container = document.getElementById('comment-list-container');
    if (!container || e.target !== container) return;

    // 判断插件评论区是否滚动触底 (预留 20px 缓冲)
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 20) {
        const loadTip = document.getElementById('shopee-infinite-load-tip');
        if (loadTip && loadTip.innerText.includes('自动加载更多')) {
            loadTip.innerText = '🔄 正在请求原网页下一页数据...';
            
            // 自动寻找 Shopee 原网页上的评价下一页按钮
            const nextBtn = document.querySelector('.shopee-icon-button--right') || 
                            document.querySelector('.product-ratings__page-controller .shopee-button-outline:last-child');
            
            if (nextBtn && !nextBtn.disabled) {
                console.log('[中文翻译助手] 检测到插件触底，自动触发原网页翻页按钮');
                nextBtn.click();
            } else {
                loadTip.innerText = `✨ 已加载全部捕获到的 ${capturedCommentsCount} 条评价`;
            }
        }
    }
}, true); // 使用捕获模式确保能监听到内部 div 的滚动