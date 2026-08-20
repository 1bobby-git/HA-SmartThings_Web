import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import YAML from "yaml";

const readText = (path: string) => readFileSync(path, "utf8");

const addonConfig = () => YAML.parse(readText("addon/smartthings_web_bridge/config.yaml")) as Record<string, unknown>;
const addonDockerfile = () => readText("addon/smartthings_web_bridge/Dockerfile");
const standaloneDockerfile = () => readText("docker/Dockerfile");
const composeConfig = () => YAML.parse(readText("docker/compose.example.yaml")) as Record<string, unknown>;

describe("Home Assistant add-on metadata", () => {
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

  test("keeps noVNC and websockify internal-only while exposing only ingress", () => {
    const nginx = readText("addon/smartthings_web_bridge/rootfs/etc/nginx/nginx.conf");
    const novncRun = readText("addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/novnc/run");
    const x11vncRun = readText("addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d/x11vnc/run");
    const dockerfile = addonDockerfile();

    expect(nginx).toContain("listen 8099;");
    expect(nginx).toContain("access_log off;");
    expect(nginx).toContain("error_log /dev/stderr");
    expect(nginx).toContain("allow 172.30.32.2;");
    expect(nginx).toContain("deny all;");
    expect(nginx.indexOf("allow 172.30.32.2;")).toBeLessThan(nginx.indexOf("deny all;"));
    expect(nginx).toContain("proxy_pass http://127.0.0.1:6080/");
    expect(novncRun).toContain("exec websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900");
    expect(x11vncRun).toContain("exec x11vnc -display :99 -localhost");
    expect(dockerfile).toContain("EXPOSE 8099");
    expect(dockerfile).not.toMatch(/EXPOSE\s+(5900|6080)\b/);
  });

  test("declares expected services, dependencies, and add-on entrypoint", () => {
    const serviceRoot = "addon/smartthings_web_bridge/rootfs/etc/s6-overlay/s6-rc.d";
    const dockerfile = addonDockerfile();

    expect(readText(`${serviceRoot}/bridge/run`)).toContain("exec node --experimental-sqlite /app/dist/bridge/src/main.js");
    expect(readText(`${serviceRoot}/bridge/run`)).not.toContain("--experimental-strip-types");
    expect(readText(`${serviceRoot}/bridge/run`)).not.toContain("/app/bridge/src/main.ts");
    expect(readText(`${serviceRoot}/nginx/run`)).toContain('exec nginx -c /etc/nginx/nginx.conf -g "daemon off;"');
    expect(readText(`${serviceRoot}/xvfb/run`)).toContain("exec Xvfb :99 -screen 0 1440x1000x24 -nolisten tcp");
    expect(readText(`${serviceRoot}/x11vnc/dependencies.d/xvfb`).trim()).toBe("");
    expect(readText(`${serviceRoot}/novnc/dependencies.d/x11vnc`).trim()).toBe("");
    expect(readText(`${serviceRoot}/openbox/dependencies.d/xvfb`).trim()).toBe("");
    expect(readText(`${serviceRoot}/bridge/dependencies.d/xvfb`).trim()).toBe("");
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

  test("documents minimal AppArmor access and runtime validation gap", () => {
    const apparmor = readText("addon/smartthings_web_bridge/apparmor.txt");
    const docs = readText("addon/smartthings_web_bridge/DOCS.md");

    expect(apparmor).toContain("file,");
    expect(apparmor).toContain("signal (send) peer=unconfined,");
    expect(apparmor).toContain("signal (send) peer=smartthings_web_bridge,");
    expect(apparmor).toContain("/init ix,");
    expect(apparmor).toContain("/bin/** ix,");
    expect(apparmor).toContain("/usr/bin/** ix,");
    expect(apparmor).toContain("/run/{s6,s6-rc*,service}/** ix,");
    expect(apparmor).toContain("/package/** ix,");
    expect(apparmor).toContain("/command/** ix,");
    expect(apparmor).toContain("/etc/s6-overlay/** rix,");
    expect(apparmor).toContain("/run/{,**} rwk,");
    expect(apparmor).toContain("/tmp/** rwk,");
    expect(apparmor).toContain("/dev/shm/** rw,");
    expect(apparmor).toContain("/dev/null rw,");
    expect(apparmor).toContain("/dev/random r,");
    expect(apparmor).toContain("/dev/urandom r,");
    expect(apparmor).toContain("/dev/pts/** rw,");
    expect(apparmor).toContain("/proc/** r,");
    expect(apparmor).toContain("/sys/devices/system/cpu/** r,");
    expect(apparmor).toContain("/tmp/.X11-unix/** rw,");
    expect(apparmor).toContain("/data/** rwk,");
    expect(apparmor).not.toMatch(/\bcapability\b/);
    expect(apparmor).not.toContain("complain");
    expect(docs).toContain("AppArmor runtime enforcement has not been validated on a live Home Assistant Supervisor install");
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
