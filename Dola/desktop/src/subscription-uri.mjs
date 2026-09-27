// Extracted from web/src/lib/server/magic-proxy-service.ts.
function parseNodeUriLines(text) {
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const nodes = [];
    for (const line of lines) {
        if (line.startsWith("ss://")) {
            const node = parseShadowsocksUri(line);
            if (node)
                nodes.push(node);
        }
        else if (line.startsWith("trojan://")) {
            const node = parseTrojanUri(line);
            if (node)
                nodes.push(node);
        }
        else if (line.startsWith("vless://")) {
            const node = parseVlessUri(line);
            if (node)
                nodes.push(node);
        }
        else if (line.startsWith("vmess://")) {
            const node = parseVmessUri(line);
            if (node)
                nodes.push(node);
        }
    }
    return nodes.length > 0 ? nodes : null;
}
function parseShadowsocksUri(uri) {
    const hashIndex = uri.indexOf("#");
    const name = hashIndex !== -1 ? safeDecodeUriComponent(uri.slice(hashIndex + 1).trim()) : "";
    const withoutScheme = uri.slice(5, hashIndex !== -1 ? hashIndex : undefined);
    const atIndex = withoutScheme.indexOf("@");
    if (atIndex !== -1) {
        const userInfo = withoutScheme.slice(0, atIndex);
        const hostPortPart = withoutScheme.slice(atIndex + 1);
        let method = "";
        let password = "";
        if (userInfo.includes(":")) {
            const colon = userInfo.indexOf(":");
            method = userInfo.slice(0, colon);
            password = userInfo.slice(colon + 1);
        }
        else {
            try {
                const decodedUser = Buffer.from(userInfo.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
                const colon = decodedUser.indexOf(":");
                if (colon !== -1) {
                    method = decodedUser.slice(0, colon);
                    password = decodedUser.slice(colon + 1);
                }
            }
            catch {
                return null;
            }
        }
        const questionIndex = hostPortPart.indexOf("?");
        const hostPort = questionIndex !== -1 ? hostPortPart.slice(0, questionIndex) : hostPortPart;
        const lastColon = hostPort.lastIndexOf(":");
        if (lastColon === -1)
            return null;
        const server = hostPort.slice(0, lastColon);
        const port = Number(hostPort.slice(lastColon + 1));
        if (!server || !port || !method || !password)
            return null;
        return {
            name: name || `${server}:${port}`,
            type: "ss",
            server,
            port,
            cipher: method,
            password,
            udp: true,
        };
    }
    else {
        try {
            const decoded = Buffer.from(withoutScheme.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
            const at = decoded.indexOf("@");
            if (at === -1)
                return null;
            const user = decoded.slice(0, at);
            const hostPort = decoded.slice(at + 1);
            const userColon = user.indexOf(":");
            const lastColon = hostPort.lastIndexOf(":");
            if (userColon === -1 || lastColon === -1)
                return null;
            const method = user.slice(0, userColon);
            const password = user.slice(userColon + 1);
            const server = hostPort.slice(0, lastColon);
            const port = Number(hostPort.slice(lastColon + 1));
            if (!server || !port || !method || !password)
                return null;
            return {
                name: name || `${server}:${port}`,
                type: "ss",
                server,
                port,
                cipher: method,
                password,
                udp: true,
            };
        }
        catch {
            return null;
        }
    }
}
function parseTrojanUri(uri) {
    const hashIndex = uri.indexOf("#");
    const name = hashIndex !== -1 ? safeDecodeUriComponent(uri.slice(hashIndex + 1).trim()) : "";
    const target = hashIndex !== -1 ? uri.slice(0, hashIndex) : uri;
    try {
        const url = new URL(target);
        const password = decodeURIComponent(url.username || "");
        const server = url.hostname;
        const port = Number(url.port) || 443;
        if (!password || !server)
            return null;
        const params = url.searchParams;
        const sni = params.get("sni") || params.get("peer") || "";
        const allowInsecure = params.get("allowInsecure") === "1" || params.get("insecure") === "1";
        const network = params.get("type") || "tcp";
        const node = {
            name: name || `${server}:${port}`,
            type: "trojan",
            server,
            port,
            password,
            udp: true,
            ...(sni ? { sni } : {}),
            ...(allowInsecure ? { "skip-cert-verify": true } : {}),
        };
        if (network === "ws") {
            node.network = "ws";
            const path = params.get("path");
            const host = params.get("host") || sni;
            node["ws-opts"] = {
                ...(path ? { path } : {}),
                ...(host ? { headers: { Host: host } } : {}),
            };
        }
        else if (network === "grpc") {
            node.network = "grpc";
            const serviceName = params.get("serviceName");
            if (serviceName)
                node["grpc-opts"] = { "grpc-service-name": serviceName };
        }
        return node;
    }
    catch {
        return null;
    }
}
function parseVlessUri(uri) {
    const hashIndex = uri.indexOf("#");
    const name = hashIndex !== -1 ? safeDecodeUriComponent(uri.slice(hashIndex + 1).trim()) : "";
    const target = hashIndex !== -1 ? uri.slice(0, hashIndex) : uri;
    try {
        const url = new URL(target);
        const uuid = decodeURIComponent(url.username || "");
        const server = url.hostname;
        const port = Number(url.port) || 443;
        if (!uuid || !server)
            return null;
        const params = url.searchParams;
        const flow = params.get("flow") || "";
        const security = params.get("security") || "";
        const sni = params.get("sni") || "";
        const allowInsecure = params.get("allowInsecure") === "1" || params.get("insecure") === "1";
        const network = params.get("type") || "tcp";
        const node = {
            name: name || `${server}:${port}`,
            type: "vless",
            server,
            port,
            uuid,
            udp: true,
            ...(flow ? { flow } : {}),
            ...(security === "tls" || security === "reality" ? { tls: true } : {}),
            ...(sni ? { servername: sni } : {}),
            ...(allowInsecure ? { "skip-cert-verify": true } : {}),
        };
        if (security === "reality") {
            const pbk = params.get("pbk") || "";
            const sid = params.get("sid") || "";
            const fp = params.get("fp") || "chrome";
            node["reality-opts"] = {
                "public-key": pbk,
                ...(sid ? { "short-id": sid } : {}),
            };
            if (fp)
                node["client-fingerprint"] = fp;
        }
        if (network === "ws") {
            node.network = "ws";
            const path = params.get("path");
            const host = params.get("host") || sni;
            node["ws-opts"] = {
                ...(path ? { path } : {}),
                ...(host ? { headers: { Host: host } } : {}),
            };
        }
        else if (network === "grpc") {
            node.network = "grpc";
            const serviceName = params.get("serviceName");
            if (serviceName)
                node["grpc-opts"] = { "grpc-service-name": serviceName };
        }
        return node;
    }
    catch {
        return null;
    }
}
function parseVmessUri(uri) {
    const raw = uri.slice(8).trim();
    try {
        const json = JSON.parse(Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        const server = String(json.add || "");
        const port = Number(json.port);
        const uuid = String(json.id || "");
        const name = String(json.ps || `${server}:${port}`);
        if (!server || !port || !uuid)
            return null;
        const alterId = Number(json.aid) || 0;
        const cipher = String(json.scy || "auto");
        const tls = json.tls === "tls";
        const sni = String(json.sni || json.host || "");
        const network = String(json.net || "tcp");
        const node = {
            name,
            type: "vmess",
            server,
            port,
            uuid,
            alterId,
            cipher,
            udp: true,
            ...(tls ? { tls: true } : {}),
            ...(sni ? { servername: sni } : {}),
        };
        if (network === "ws") {
            node.network = "ws";
            const path = String(json.path || "/");
            const host = String(json.host || sni || "");
            node["ws-opts"] = {
                ...(path ? { path } : {}),
                ...(host ? { headers: { Host: host } } : {}),
            };
        }
        else if (network === "grpc") {
            node.network = "grpc";
            const serviceName = String(json.path || "");
            if (serviceName)
                node["grpc-opts"] = { "grpc-service-name": serviceName };
        }
        return node;
    }
    catch {
        return null;
    }
}
function safeDecodeUriComponent(str) {
    try {
        return decodeURIComponent(str);
    }
    catch {
        return str;
    }
}
export { parseNodeUriLines };
