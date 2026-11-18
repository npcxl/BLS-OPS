import { describe, expect, it } from "vitest";
import {
  classifySite,
  entryFiles,
  matchServers,
  parseNginxConfig,
  proxyTargets,
  staticDirs,
  summarizeSite,
} from "../extreme-core/site-discovery";

// 用例 1：整台机器没有 Docker，Nginx 直接托管 OPS。
const HOST_NGINX = `
# configuration file /etc/nginx/nginx.conf:
user www-data;
http {
    include /etc/nginx/conf.d/*.conf;
}

# configuration file /etc/nginx/conf.d/ops.conf:
server {
    listen 80;
    server_name ops.xlcig.cn;
    root /var/www/ops;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /assets/ {
        alias /var/www/ops/static/;
    }
}
`;

// 用例 3：同一 Nginx 上既有静态站点，又有反代接口。
const MIXED_NGINX = `
# configuration file /etc/nginx/conf.d/site.conf:
server {
    listen 443 ssl;
    server_name ops.xlcig.cn admin.xlcig.cn;

    location / {
        root /srv/ops-frontend;
        index index.html;
    }

    location /api/ {
        proxy_pass http://10.0.0.9:8080/;
    }
}
`;

// 用例 2：共享 Nginx 容器（容器名不带 ops），仍负责 ops.xlcig.cn。
const SHARED_NGINX = `
# configuration file /etc/nginx/conf.d/default.conf:
server {
    listen 8080;
    server_name _;
    root /usr/share/nginx/html;
}

server {
    listen 8080;
    server_name ops.xlcig.cn;
    location / {
        root /var/www/ops;
    }
}
`;

describe("parseNginxConfig", () => {
  it("按 -T 的文件分隔行标注来源，并读出 root / index", () => {
    const servers = parseNginxConfig(HOST_NGINX);
    const ops = servers.find((server) => server.serverNames.includes("ops.xlcig.cn"))!;
    expect(ops.file).toBe("/etc/nginx/conf.d/ops.conf");
    expect(ops.listen).toEqual(["80"]);
    expect(ops.root).toBe("/var/www/ops");
    expect(ops.locations).toHaveLength(2);
    expect(ops.locations[1].alias).toBe("/var/www/ops/static/");
  });

  it("没有分隔行时把整份当一段解析", () => {
    const servers = parseNginxConfig(
      `server { listen 80; server_name a.test; root /srv/a; }`,
    );
    expect(servers).toHaveLength(1);
    expect(servers[0].serverNames).toEqual(["a.test"]);
  });

  it("注释掉的 server_name 不算", () => {
    const servers = parseNginxConfig(`
# configuration file /tmp/x.conf:
server {
    listen 80;
    # server_name old.xlcig.cn;
    server_name new.xlcig.cn;
}
`);
    expect(servers[0].serverNames).toEqual(["new.xlcig.cn"]);
  });

  it("嵌套块不会被内层 } 切断", () => {
    const servers = parseNginxConfig(`
# configuration file /tmp/n.conf:
server {
    listen 80;
    server_name ops.test;
    location / {
        if ($host = a.test) { return 301 https://b.test; }
        root /srv/nested;
    }
    location /api/ { proxy_pass http://127.0.0.1:9000; }
}
`);
    expect(servers[0].locations).toHaveLength(2);
    expect(servers[0].locations[0].root).toBe("/srv/nested");
    expect(servers[0].locations[1].proxyPass).toBe("http://127.0.0.1:9000");
  });
});

describe("matchServers", () => {
  const servers = parseNginxConfig(SHARED_NGINX);

  it("精确域名命中，且不会把 _ 默认站点当成目标", () => {
    const hit = matchServers(servers, "ops.xlcig.cn");
    expect(hit).toHaveLength(1);
    expect(hit[0].root).toBe("/var/www/ops");

    // `_` 是"所有未匹配域名"，不能算命中某个具体域名。
    expect(matchServers(servers, "other.test")).toHaveLength(0);
  });

  it("支持通配与前缀写法", () => {
    const wildcard = parseNginxConfig(`server { server_name *.xlcig.cn; }`);
    expect(matchServers(wildcard, "ops.xlcig.cn")).toHaveLength(1);

    const prefix = parseNginxConfig(`server { server_name .xlcig.cn; }`);
    expect(matchServers(prefix, "admin.xlcig.cn")).toHaveLength(1);
  });
});

describe("站点类型与目录", () => {
  it("宿主机静态站点：static + 目录 + 入口文件", () => {
    const ops = matchServers(parseNginxConfig(HOST_NGINX), "ops.xlcig.cn")[0];
    expect(classifySite(ops)).toBe("static");
    // alias 与 root 都算目录来源。
    expect(staticDirs(ops)).toEqual(["/var/www/ops", "/var/www/ops/static/"]);
    expect(entryFiles(ops)).toEqual(["index.html"]);
  });

  it("同一 server 里静态 + 反代判为 mixed，并列出上游", () => {
    const mixed = matchServers(parseNginxConfig(MIXED_NGINX), "admin.xlcig.cn")[0];
    expect(classifySite(mixed)).toBe("mixed");
    expect(staticDirs(mixed)).toEqual(["/srv/ops-frontend"]);
    expect(proxyTargets(mixed)).toEqual(["10.0.0.9:8080"]);
  });

  it("纯反代站点拿不到静态目录", () => {
    const proxyOnly = parseNginxConfig(`
server {
    server_name api.test;
    location / { proxy_pass http://127.0.0.1:9000/; }
}
`)[0];
    expect(classifySite(proxyOnly)).toBe("proxy");
    expect(staticDirs(proxyOnly)).toEqual([]);
  });

  it("root 写在 server 级也算静态", () => {
    const server = parseNginxConfig(`
server { server_name s.test; root /srv/s; location / { try_files $uri $uri/ /index.html; } }
`)[0];
    expect(classifySite(server)).toBe("static");
    expect(staticDirs(server)).toEqual(["/srv/s"]);
  });
});

describe("summarizeSite", () => {
  it("静态站点给出目录，反代给出上游", () => {
    const host = matchServers(parseNginxConfig(HOST_NGINX), "ops.xlcig.cn")[0];
    expect(summarizeSite({ domain: "ops.xlcig.cn", instance: "宿主机 nginx", server: host })).toEqual({
      domain: "ops.xlcig.cn",
      instance: "宿主机 nginx",
      kind: "static",
      target: "/var/www/ops, /var/www/ops/static/",
    });

    const proxyOnly = parseNginxConfig(`
server { server_name api.test; location / { proxy_pass http://127.0.0.1:9000; } }
`)[0];
    expect(summarizeSite({ domain: "api.test", instance: "容器 nginx", server: proxyOnly }).target).toBe(
      "127.0.0.1:9000",
    );
  });
});
