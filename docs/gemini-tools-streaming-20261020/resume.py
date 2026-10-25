import pathlib, hashlib, tarfile, subprocess, os, re, shutil

SHA = "3a11515073c4bc69e5ed5b68ebcbf466cd3ee4d3cfa23965356af6a5b3742604"
TAG = "dreamyo-app:release-20261020-gemini-tools-streaming"
BASE = pathlib.Path("/opt/www/dreamyo/patches/gemini-tools-streaming-20261020")
COMPOSE = "/opt/www/dreamyo/docker-compose.offline-external-db.yml"
out = BASE / "web-update.tar.gz"
URL = "http://192.168.100.43:50405/gemini-tools-streaming-web-20261020.tar.gz"
import urllib.request
urllib.request.urlretrieve(URL, out)
os.chmod(out, 0o600)
got = hashlib.sha256(out.read_bytes()).hexdigest()
assert got == SHA, "sha mismatch on downloaded tar: " + got
print("[1/6] tar downloaded and verified", out.stat().st_size, "bytes", flush=True)

env_path = pathlib.Path("/opt/www/dreamyo/.env")
data = env_path.read_text()
m = re.search(r"^DREAMYO_IMAGE='?([^'\"#\r\n]+)'?", data, re.M)
assert m, "DREAMYO_IMAGE not found in .env"
current = m.group(1).strip()
assert "20261016" in current, "unexpected base image: " + current
print("[2/6] base image:", current, flush=True)

shutil.rmtree(BASE / "runtime", ignore_errors=True)
with tarfile.open(out) as t:
    t.extractall(BASE, filter="fully_trusted")
assert (BASE / "runtime" / "server.js").exists(), "extraction incomplete"
assert any((BASE / "runtime" / "node_modules" / ".pnpm").glob("sharp@0.35.4*")), "sharp package dir missing"
print("[3/6] extracted (fully_trusted, standalone symlinks kept)", flush=True)

(BASE / "Dockerfile").write_text("FROM " + current + "\nCOPY --chown=node:node runtime/ /app/web/\n")
subprocess.run(["docker", "build", "--network=none", "-t", TAG, str(BASE)], check=True)
print("[4/6] IMAGE_READY", TAG, flush=True)

backup = BASE / "env.before-gemini-tools"
assert not backup.exists(), "backup already exists, refusing to rerun"
backup.write_text(data)
os.chmod(backup, 0o600)
old = "DREAMYO_IMAGE='" + current + "'"
new = "DREAMYO_IMAGE='" + TAG + "'"
assert data.count(old) == 1, "DREAMYO_IMAGE count unexpected: " + str(data.count(old))
env_path.write_text(data.replace(old, new))
os.chmod(env_path, 0o600)
print("[5/6] .env switched, backup at " + str(backup), flush=True)

subprocess.run(["docker", "compose", "-f", COMPOSE, "up", "-d", "--no-deps", "--wait", "app", "generation-worker"], cwd="/opt/www/dreamyo", check=True)
bid = subprocess.check_output(["docker", "exec", "dreamyo", "cat", "/app/web/.next/BUILD_ID"], text=True).strip()
cnt = subprocess.run(["docker", "exec", "dreamyo", "sh", "-c", "grep -rloa streamGenerateContent /app/web/.next/server 2>/dev/null | wc -l"], capture_output=True, text=True).stdout.strip()
print("[6/6] DEPLOYED  BUILD_ID:", bid, " STREAM_FILES:", cnt, flush=True)
print("ALL_DONE", flush=True)
