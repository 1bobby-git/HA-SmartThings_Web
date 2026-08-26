import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

const readText = (path: string) => readFileSync(path, "utf8");

const addonConfig = () => YAML.parse(readText("addon/smartthings_web_bridge/config.yaml")) as Record<string, unknown>;
const addonDockerfile = () => readText("addon/smartthings_web_bridge/Dockerfile");
const standaloneDockerfile = () => readText("docker/Dockerfile");
const composeConfig = () => YAML.parse(readText("docker/compose.example.yaml")) as Record<string, unknown>;

describe("Home Assistant add-on metadata", () => {
  test("publishes native-command queue bypass as version 0.1.90", () => {
    const config = addonConfig();
    const packageMetadata = JSON.parse(readText("package.json")) as Record<string, unknown>;
    const protocolMetadata = JSON.parse(readText("protocol/version.json")) as Record<string, unknown>;
    const runtime = readText("bridge/src/runtime.ts");
    const changelog = readText("addon/smartthings_web_bridge/CHANGELOG.md");

    expect(config.version).toBe("0.1.90");
    expect(packageMetadata.version).toBe("0.1.90");
    expect(protocolMetadata.bridge_version).toBe("0.1.90");
    expect(protocolMetadata.protocol_version).toBe(4);
    expect(runtime).toContain('const bridgeVersion = "0.1.90";');
    expect(changelog).toContain("## 0.1.90");
    expect(changelog).toContain("authenticated in-page SmartThings Web client");
    expect(changelog).toContain("volatile raw identifiers");
    expect(changelog).toContain("observed toggle and refresh controls");
    expect(changelog).toContain("## 0.1.80");
    expect(changelog).toContain("before diagnostic capture");
    expect(changelog).toContain("Coalesce full normalized-inventory persistence");
    expect(changelog).toContain("duplicate-delivery protocol counters");
    expect(changelog).toContain("## 0.1.79");
    expect(changelog).toContain("matching state and device listeners");
    expect(changelog).toContain("exact visible Cake room-card heading");
    expect(changelog).toContain("entity-listener failures");
    expect(changelog).toContain("Bridge SSE delivery");
    expect(changelog).toContain("## 0.1.76");
    expect(changelog).toContain("navigation-only click event");
    expect(changelog).toContain("actionability wait");
    expect(changelog).toContain("## 0.1.75");
    expect(changelog).toContain("already rendered exact device card");
    expect(changelog).toContain("without reloading the SmartThings application");
    expect(changelog).toContain("## 0.1.74");
    expect(changelog).toContain("CSS before any page-wide accessibility-tree fallback");
    expect(changelog).toContain("already verified exact detail URL");
    expect(changelog).toContain("without waiting for the separate inspection page");
    expect(changelog).toContain("## 0.1.73");
    expect(changelog).toContain("exact room heading");
    expect(changelog).toContain("independently revalidate");
    expect(changelog).toContain("non-waiting visibility check");
    expect(changelog).toContain("exact click event");
    expect(changelog).toContain("known-invalid direct detail route");
    expect(changelog).toContain("foreground command");
    expect(changelog).toContain("same warm page");
    expect(changelog).toContain("navigation-only room button");
    expect(changelog).toContain("fixed phase diagnostics");
    expect(changelog).toContain("one cold room-navigation failure");
    expect(changelog).toContain("non-numeric pushed values");
    expect(changelog).toContain("exact accessible device-and-room heading");
    expect(changelog).toContain("device-detail route");
    expect(changelog).toContain("SmartThings icon");
    expect(changelog).toContain("## 0.1.38");
    expect(changelog).toContain("scenes");
    expect(changelog).toContain("SmartThings Home Monitor");
    expect(changelog).toContain("swatch controls");
    expect(changelog).toContain("## 0.1.29");
    expect(changelog).toContain("newer push event confirms");
    expect(changelog).toContain("separate browser page");
    expect(changelog).toContain("## 0.1.28");
    expect(changelog).toContain("component-less physical-action events");
    expect(changelog).toContain("epoch-millisecond source timestamps");
    expect(changelog).toContain("## 0.1.27");
    expect(changelog).toContain("sequence gaps");
    expect(changelog).toContain("without adding SmartThings polling");
    expect(changelog).toContain("## 0.1.26");
    expect(changelog).toContain("bounded in-memory physical-action correlation probe");
  });

  test("uses ingress watchdog and avoids broad privileges or public VNC ports", () => {
    const config = addonConfig();
    const dockerfile = addonDockerfile();

    expect(config.name).toBe("SmartThings Web Bridge");
    expect(config.slug).toBe("smartthings_web_bridge");
    expect(config.startup).toBe("services");
    expect(config.boot).toBe("auto");
    expect(config.ingress).toBe(true);
    expect(config.ingress_port).toBe(8099);
    expect(config.ingress_stream).toBe(true);
    expect(config.panel_admin).toBe(true);
    expect(config.watchdog).toBe("http://[HOST]:[PORT:8099]/health/live");
    expect(config.arch).toEqual(["amd64", "aarch64"]);
    expect(config).not.toHaveProperty("map");
    expect(config).not.toHaveProperty("host_network");
    expect(config).not.toHaveProperty("full_access");
    expect(config).not.toHaveProperty("docker_api");
    expect(config).not.toHaveProperty("privileged");
    expect(config).not.toHaveProperty("ports");
    expect(dockerfile).toContain("sha256:af843e6c2a9ad4df5daa8a68268fb59d28ab5ef55203f67c1573e4d0e154e176");
    expect(dockerfile).toContain("sha256:13d069848a305570be16443bb904132fef75fcd897703022a1a1c7841e0abac9");
    expect(dockerfile).toContain("s6-overlay");
    expect(dockerfile).toContain("PLAYWRIGHT_VERSION=1.62.1");
  });

  test("verifies exact s6-overlay checksums before extracting tarballs", () => {
    const dockerfile = addonDockerfile();

    expect(dockerfile).toContain("S6_OVERLAY_NOARCH_SHA256=5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12");
    expect(dockerfile).toContain("S6_OVERLAY_X86_64_SHA256=e6befcc96a437a3831386ecfc51808c5d3e939dc5fe3c02ae9284599e8aa2408");
    expect(dockerfile).toContain("S6_OVERLAY_AARCH64_SHA256=b17f17a82e7a515c682a91edaf2ffdabb73f891981b6c1fd712115693a2f8b4c");
    expect(dockerfile).toContain('echo "${S6_OVERLAY_NOARCH_SHA256}  /tmp/s6-overlay-noarch.tar.xz" | sha256sum -c -');
    expect(dockerfile).toContain('echo "${s6_arch_sha256}  /tmp/s6-overlay-arch.tar.xz" | sha256sum -c -');

    const noarchCheckIndex = dockerfile.indexOf("S6_OVERLAY_NOARCH_SHA256}  /tmp/s6-overlay-noarch.tar.xz");
    const archCheckIndex = dockerfile.indexOf("s6_arch_sha256}  /tmp/s6-overlay-arch.tar.xz");
    expect(noarchCheckIndex).toBeGreaterThan(-1);
    expect(archCheckIndex).toBeGreaterThan(-1);
    expect(noarchCheckIndex).toBeLessThan(dockerfile.indexOf("tar -C / -Jxpf /tmp/s6-overlay-noarch.tar.xz"));
    expect(archCheckIndex).toBeLessThan(dockerfile.indexOf("tar -C / -Jxpf /tmp/s6-overlay-arch.tar.xz"));
  });

  test("configures the pinned Chromium setuid helper without enabling broad container privileges", () => {
    const dockerfile = addonDockerfile();

    expect(dockerfile).toContain("CHROME_DEVEL_SANDBOX=/usr/local/sbin/chrome-devel-sandbox");
    expect(dockerfile).toContain("chrome-linux64/chrome_sandbox");
    expect(dockerfile).toContain("chrome-linux/chrome_sandbox");
    expect(dockerfile).toContain('chown root:root "${sandbox}"');
    expect(dockerfile).toContain('chmod 4755 "${sandbox}"');
    expect(dockerfile).toContain('ln -s "${sandbox}" /usr/local/sbin/chrome-devel-sandbox');
    expect(dockerfile).toContain('test "$(stat -c \'%u:%g:%a\' "${sandbox}")" = "0:0:4755"');
    expect(dockerfile).toContain("id -u pwuser");
    expect(dockerfile).not.toContain("--no-sandbox");
  });

  test("keeps noVNC and websockify internal-only while exposing only ingress", () => {
    const nginx = readText("addon/smartthings_web_bridge/rootfs/etc/nginx/nginx.conf");
    const novncRun = readText("addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/novnc/run");
    const x11vncRun = readText("addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/x11vnc/run");
    const dockerfile = addonDockerfile();

    expect(nginx).toMatch(/^user root;/);
    expect(nginx).toContain("listen 8099;");
    expect(nginx).toContain("listen 8100;");
    expect(nginx).toContain("include /etc/nginx/mime.types;");
    expect(nginx).toContain("access_log off;");
    expect(nginx).toContain("error_log /dev/stderr");
    expect(nginx).toContain("allow 172.30.32.2;");
    expect(nginx).toContain("allow 172.30.32.1;");
    expect(nginx).toContain("deny all;");
    expect(nginx.indexOf("allow 172.30.32.2;")).toBeLessThan(nginx.indexOf("deny all;"));
    expect(nginx).toContain("location = /novnc/websockify {");
    expect(nginx).toContain("location = /novnc-ui/websockify {");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:6080;");
    expect(nginx).toContain("location /novnc/ {");
    expect(nginx).toContain("location /novnc-ui/ {");
    expect(nginx).toContain("alias /usr/share/novnc/;");
    expect(nginx).toContain('add_header Cache-Control "no-store, no-cache, must-revalidate" always;');
    for (const directive of [
      "client_body_temp_path",
      "proxy_temp_path",
      "fastcgi_temp_path",
      "uwsgi_temp_path",
      "scgi_temp_path"
    ]) {
      expect(nginx).toContain(`${directive} /tmp;`);
    }
    expect(nginx).not.toContain("/var/lib/nginx");
    expect(novncRun).toContain(
      "exec websockify 127.0.0.1:6080 127.0.0.1:5900"
    );
    expect(novncRun).not.toContain("--web=");
    expect(novncRun).not.toContain("--libserver");
    expect(x11vncRun).toContain("exec x11vnc -display :99 -localhost");
    expect(dockerfile).toContain("EXPOSE 8099");
    expect(dockerfile).not.toMatch(/EXPOSE\s+(5900|6080)\b/);
  });

  test("declares expected services, dependencies, and add-on entrypoint", () => {
    const serviceRoot = "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d";
    const bundleRoot = "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/user-bundles.d/user";
    const dockerfile = addonDockerfile();
    const bridgeRun = readText(`${serviceRoot}/bridge/run`);
    const prepareData = readText("addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/prepare-data");

    expect(bridgeRun).toMatch(/^#!\/command\/with-contenv sh/);
    expect(bridgeRun).toContain("export HOME=/data");
    expect(bridgeRun).toContain("export XDG_CACHE_HOME=/data/chromium-profile/.cache");
    expect(bridgeRun).toContain("export XDG_CONFIG_HOME=/data/chromium-profile/.config");
    expect(bridgeRun).toContain("exec s6-setuidgid pwuser node --experimental-sqlite /app/dist/bridge/src/main.js");
    expect(bridgeRun).not.toMatch(/^mkdir\b/m);
    expect(bridgeRun).not.toMatch(/^chmod\b/m);
    expect(bridgeRun).not.toContain("--experimental-strip-types");
    expect(bridgeRun).not.toContain("/app/bridge/src/main.ts");
    expect(readText(`${serviceRoot}/nginx/run`)).toContain('exec nginx -c /etc/nginx/nginx.conf -g "daemon off;"');
    expect(readText(`${serviceRoot}/openbox/run`)).toContain("export HOME=/tmp/openbox-home");
    expect(readText(`${serviceRoot}/openbox/run`)).toContain("export XDG_CACHE_HOME=/tmp/openbox-cache");
    expect(readText(`${serviceRoot}/xvfb/run`)).toContain("exec Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp");
    expect(readText(`${serviceRoot}/xvfb-ready/type`).trim()).toBe("oneshot");
    expect(readText(`${serviceRoot}/xvfb-ready/dependencies.d/xvfb`).trim()).toBe("");
    expect(readText(`${serviceRoot}/xvfb-ready/up`).trim()).toBe(
      "/etc/s6-overlay/scripts/wait-xvfb"
    );
    expect(readText(`${serviceRoot}/xvfb/run`)).toContain("-nolock");
    const waitXvfb = readText("addon/smartthings_web_bridge/rootfs/etc/s6-overlay/scripts/wait-xvfb");
    expect(waitXvfb).toContain("xdpyinfo -display :99");
    expect(waitXvfb).toContain("s6-sleep -m 100");
    expect(waitXvfb).not.toContain("sleep 0.1");
    expect(readText(`${serviceRoot}/x11vnc/dependencies.d/xvfb-ready`).trim()).toBe("");
    expect(readText(`${serviceRoot}/novnc/dependencies.d/x11vnc`).trim()).toBe("");
    expect(readText(`${serviceRoot}/openbox/dependencies.d/xvfb-ready`).trim()).toBe("");
    expect(readText(`${serviceRoot}/bridge/dependencies.d/xvfb-ready`).trim()).toBe("");
    expect(readText(`${serviceRoot}/bridge/dependencies.d/data-prep`).trim()).toBe("");
    expect(readText(`${serviceRoot}/data-prep/type`).trim()).toBe("oneshot");
    expect(readText(`${serviceRoot}/data-prep/up`).trim()).toBe(
      "/etc/s6-overlay/scripts/prepare-data"
    );
    expect(prepareData).toContain("test -d /data");
    expect(prepareData).toContain("exec chown -R pwuser:pwuser /data");
    expect(readText(`${bundleRoot}/type`).trim()).toBe("bundle");
    for (const service of ["bridge", "data-prep", "nginx", "novnc", "openbox", "x11vnc", "xvfb", "xvfb-ready"]) {
      expect(readText(`${bundleRoot}/contents.d/${service}`).trim()).toBe("");
    }
    expect(existsSync(`${serviceRoot}/user`)).toBe(false);
    expect(dockerfile).toContain("x11-utils");
    expect(dockerfile).toContain("-name up");
    expect(dockerfile).toContain("chmod +x /etc/s6-overlay/scripts/*");
    expect(dockerfile).toContain('ENTRYPOINT ["/init"]');
    expect(dockerfile).not.toMatch(/--privileged|CAP_SYS_ADMIN|host\.docker\.internal/);
  });

  test("builds compiled bridge output before pruning production dependencies", () => {
    const dockerfile = addonDockerfile();

    expect(dockerfile).toContain("COPY tsconfig.build.json ./");
    expect(dockerfile).toContain("RUN npm ci");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("RUN npm prune --omit=dev");
    expect(dockerfile.indexOf("RUN npm ci")).toBeLessThan(dockerfile.indexOf("RUN npm run build"));
    expect(dockerfile.indexOf("RUN npm run build")).toBeLessThan(dockerfile.indexOf("RUN npm prune --omit=dev"));
    expect(dockerfile).not.toContain("COPY addon/smartthings_web_bridge/apparmor.txt /etc/apparmor.d/smartthings_web_bridge");
  });

  test("uses paths that are valid from the generated add-on package root", () => {
    const dockerfile = addonDockerfile();

    expect(dockerfile).toContain("COPY package.json package-lock.json tsconfig.json ./");
    expect(dockerfile).not.toContain("vitest.config.ts");
    expect(dockerfile).toContain("COPY tsconfig.build.json ./");
    expect(dockerfile).toContain("COPY bridge ./bridge");
    expect(dockerfile).toContain("COPY rootfs /");
    expect(dockerfile).not.toContain("COPY addon/smartthings_web_bridge/rootfs /");
  });

  test("documents minimal AppArmor access and runtime validation gap", () => {
    const apparmor = readText("addon/smartthings_web_bridge/apparmor.txt");
    const docs = readText("addon/smartthings_web_bridge/DOCS.md");

    expect(apparmor).not.toMatch(/^\s*file,\s*$/m);
    expect(apparmor).toContain("signal (send) peer=unconfined,");
    expect(apparmor).toContain("signal (send) peer=smartthings_web_bridge,");
    expect(apparmor).toContain("/init rix,");
    expect(apparmor).not.toContain("/init ix,");
    expect(apparmor).toContain("/bin/** ix,");
    expect(apparmor).toContain("/usr/bin/** ix,");
    expect(apparmor).toContain("/usr/lib/cargo/bin/coreutils/** ix,");
    expect(apparmor).toContain("/bin/sleep ix,");
    expect(apparmor).toContain("/usr/bin/sleep ix,");
    expect(apparmor).toContain("/usr/sbin/nginx ix,");
    expect(apparmor).toContain("/ms-playwright/chromium-1234/{,**} rm,");
    expect(apparmor).toContain(
      "/ms-playwright/chromium-1234/chrome-linux64/chrome rix,"
    );
    expect(apparmor).toContain(
      "/ms-playwright/chromium-1234/chrome-linux64/chrome_crashpad_handler rix,"
    );
    expect(apparmor).toContain(
      "/ms-playwright/chromium-1234/chrome-linux64/chrome_sandbox rix,"
    );
    expect(apparmor).toContain("/ms-playwright/chromium-1234/chrome-linux/chrome rix,");
    expect(apparmor).toContain(
      "/ms-playwright/chromium-1234/chrome-linux/chrome_crashpad_handler rix,"
    );
    expect(apparmor).toContain("/ms-playwright/chromium-1234/chrome-linux/chrome_sandbox rix,");
    expect(apparmor).toContain("/usr/local/sbin/chrome-devel-sandbox rix,");
    expect(apparmor).not.toContain("/ms-playwright/** rix,");
    expect(apparmor).not.toContain("/usr/sbin/** ix,");
    expect(apparmor).toContain("/etc/nginx/nginx.conf r,");
    expect(apparmor).toContain("/etc/nginx/mime.types r,");
    expect(apparmor).not.toContain("/etc/nginx/** r,");
    expect(apparmor).toContain("/etc/fonts/{,**} r,");
    expect(apparmor).toContain("/etc/xdg/openbox/{,**} r,");
    expect(apparmor).not.toContain("/etc/** r,");
    expect(apparmor).toContain("/usr/share/novnc/ r,");
    expect(apparmor).toContain("/usr/share/novnc/** r,");
    expect(apparmor).toContain("/etc/ssl/{,**} r,");
    expect(apparmor).toContain("/var/lib/xkb/{,**} rw,");
    expect(apparmor).not.toContain("/var/lib/** rw,");
    expect(apparmor).toContain("/var/cache/fontconfig/{,**} rwk,");
    expect(apparmor).toContain("/run/{s6,s6-rc*,service}/** ix,");
    expect(apparmor).toContain("/package/admin/s6-overlay-3.2.3.2/libexec/{,**} rix,");
    expect(apparmor).toContain("/package/admin/s6-overlay-3.2.3.2/command/{,**} rix,");
    expect(apparmor).toContain("/package/admin/s6-overlay-3.2.3.2/etc/s6-rc/scripts/{,**} rix,");
    expect(apparmor).toContain("/package/admin/s6-overlay-3.2.3.2/etc/s6-linux-init/skel/{,**} r,");
    expect(apparmor).toContain("/package/admin/s6-overlay-3.2.3.2/etc/s6-rc/sources/{,**} r,");
    expect(apparmor).not.toContain("/package/admin/s6-overlay-3.2.3.2/etc/s6-rc/sources/** r,");
    expect(apparmor).not.toContain("/package/admin/s6-overlay-3.2.3.2/etc/** r,");
    expect(apparmor).toContain("/package/** ix,");
    expect(apparmor).not.toContain("/package/** rix,");
    expect(apparmor).not.toContain("/package/** r,");
    expect(apparmor).toContain("/command/** ix,");
    expect(apparmor).toContain("/etc/s6-overlay/** rix,");
    expect(apparmor).toContain("/run/{,**} rwk,");
    expect(apparmor).toContain("/tmp/** rwk,");
    expect(apparmor).toContain("/dev/shm/** rw,");
    expect(apparmor).toContain("/dev/null rw,");
    expect(apparmor).toContain("/dev/random r,");
    expect(apparmor).toContain("/dev/urandom r,");
    expect(apparmor).toContain("/dev/pts/** rw,");
    expect(apparmor).toContain("/proc/ r,");
    expect(apparmor).toContain("/proc/** r,");
    expect(apparmor).toContain(
      "owner /proc/[0-9]*/{setgroups,uid_map,gid_map,oom_score_adj} w,"
    );
    expect(apparmor).not.toMatch(
      /^\s*\/proc\/\[0-9\]\*\/{setgroups,uid_map,gid_map,oom_score_adj}\s+w,/m
    );
    expect(apparmor).not.toMatch(/^\s*\/proc\/\*\*\s+rw/mi);
    expect(apparmor).toContain("/etc/gnutls/config r,");
    expect(apparmor).toContain("/sys/devices/system/cpu/** r,");
    expect(apparmor).toContain("/tmp/.X11-unix/** rw,");
    expect(apparmor).toContain("/data/ rwk,");
    expect(apparmor).not.toContain("/data rwk,");
    expect(apparmor).toContain("/data/** rwk,");
    expect(apparmor).toContain("capability setgid,");
    expect(apparmor).toContain("capability setuid,");
    expect(apparmor).toContain("capability chown,");
    expect(apparmor).toContain("capability dac_override,");
    expect(apparmor).toContain("capability setpcap,");
    expect(apparmor).toContain("capability sys_chroot,");
    expect(apparmor).toContain("capability sys_admin,");
    expect(apparmor).not.toMatch(/^\s*capability,\s*$/m);
    expect(apparmor).not.toMatch(/^\s*userns(?:\s+create)?,\s*$/m);
    expect(apparmor).not.toContain("complain");
    expect(docs).toContain("Supervisor-loaded AppArmor profile is enforced");
  });
});

describe("standalone Docker container", () => {
  test("uses the Playwright multiarch manifest-list digest and compiled runtime", () => {
    const dockerfile = standaloneDockerfile();

    expect(dockerfile).toContain(
      "FROM mcr.microsoft.com/playwright:v1.62.1-resolute@sha256:aebd85bce8056dcdc2269853fd94ea432b6a201da4f0ef125b509489ecd52ddb",
    );
    expect(dockerfile).not.toContain("sha256:af843e6c2a9ad4df5daa8a68268fb59d28ab5ef55203f67c1573e4d0e154e176");
    expect(dockerfile).toContain("DISPLAY=:99");
    expect(dockerfile).toContain("STW_HOST=127.0.0.1");
    expect(dockerfile).toContain("STW_PORT=8098");
    expect(dockerfile).toContain("COPY tsconfig.build.json ./");
    expect(dockerfile).toContain("RUN npm ci");
    expect(dockerfile).toContain("RUN npm run build");
    expect(dockerfile).toContain("RUN npm prune --omit=dev");
    expect(dockerfile).toContain("COPY addon/smartthings_web_bridge/rootfs /");
    expect(dockerfile).toContain("COPY docker/nginx.conf /etc/nginx/nginx.conf");
    expect(dockerfile).toContain("EXPOSE 8099");
    expect(dockerfile).not.toMatch(/EXPOSE\s+(5900|6080|8098)\b/);
    expect(dockerfile).toContain('ENTRYPOINT ["/init"]');
    expect(dockerfile).not.toContain("--experimental-strip-types");
    expect(dockerfile).not.toContain("/app/bridge/src/main.ts");
  });

  test("installs the headed supervision stack and preserves s6 checksum verification", () => {
    const dockerfile = standaloneDockerfile();

    expect(dockerfile).toContain("nginx");
    expect(dockerfile).toContain("openbox");
    expect(dockerfile).toContain("x11vnc");
    expect(dockerfile).toContain("xvfb");
    expect(dockerfile).toContain("websockify");
    expect(dockerfile).toContain("novnc");
    expect(dockerfile).toContain("S6_OVERLAY_NOARCH_SHA256=5379750ed30a84bbd2e2dd74847ba6b5bd29cd0b2e3ea2ec58049b57eb2eda12");
    expect(dockerfile).toContain("sha256sum -c -");
  });

  test("uses standalone nginx without Supervisor-only ingress source restriction", () => {
    const nginx = readText("docker/nginx.conf");

    expect(nginx).toContain("listen 8099;");
    expect(nginx).toContain("access_log off;");
    expect(nginx).toContain("error_log /dev/stderr");
    expect(nginx).toContain("proxy_pass http://127.0.0.1:6080/");
    expect(nginx).not.toContain("allow 172.30.32.2;");
    expect(nginx).not.toContain("deny all;");
  });

  test("compose exposes only local ingress and uses container shm sizing", () => {
    const compose = composeConfig() as {
      services?: Record<string, Record<string, unknown>>;
    };
    const service = compose.services?.["smartthings-web-bridge"];

    expect(service?.ports).toEqual(["127.0.0.1:8099:8099"]);
    expect(service?.shm_size).toBe("1gb");
    expect(service).not.toHaveProperty("ipc");
    expect(service).not.toHaveProperty("privileged");
    expect(service).not.toHaveProperty("cap_add");
  });
});
