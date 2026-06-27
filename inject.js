(function() {
    const originFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originFetch(...args);
        const url = args[0];

        // 匹配获取评价的接口
        if (typeof url === 'string' && url.includes('api/v2/item/get_ratings')) {
            const cloneResp = response.clone();
            cloneResp.json().then(data => {
                // 触发自定义事件，把捕获到的纯 JSON 数据传给 content.js
                const event = new CustomEvent('SHOPEE_RATINGS_CAPTURED', { detail: data });
                window.dispatchEvent(event);
            }).catch(err => console.error("解析评价JSON失败:", err));
        }
        return response;
    };
})();