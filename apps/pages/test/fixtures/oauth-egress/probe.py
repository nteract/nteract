import json
import os
import socket
import subprocess

# This runs only in a disposable container with --network none. Assign both
# public and private destinations locally to exercise real kernel routing.
v4 = [
    "8.8.8.8",
    "10.1.2.3",
    "100.100.100.200",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.1.1",
    "192.168.1.1",
    "198.18.1.1",
    "0.1.2.3",
    "240.0.0.1",
]
v6 = [
    "2606:4700:4700::1111",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
    "2001:0:1::1",
    "2002:a00:1::1",
    "64:ff9b::a00:1",
]
# Refuse to run outside the isolated Docker fixture. In particular, never
# add addresses or install nft rules on a developer workstation or host.
assert os.path.exists("/.dockerenv"), "run scripts/oauth-egress-smoke.mjs"
links = json.loads(subprocess.check_output(["ip", "-j", "link"]))
assert all(link["ifname"] == "lo" or "UP" not in link["flags"] for link in links), (
    "expected --network none"
)
subprocess.run(["ip", "link", "set", "lo", "up"], check=True)
for ip in v4:
    if ip != "127.0.0.1":
        subprocess.run(["ip", "addr", "add", ip + "/32", "dev", "lo"], check=True)
for ip in v6:
    if ip != "::1":
        subprocess.run(["ip", "-6", "addr", "add", ip + "/128", "dev", "lo"], check=True)


def address(ip, port):
    return (ip, port, 0, socket.if_nametoindex("lo")) if ip.startswith("fe80:") else (ip, port)


listeners = []
for ip in v4 + v6:
    for port in [443, 8443]:
        s = socket.socket(socket.AF_INET6 if ":" in ip else socket.AF_INET)
        if ":" in ip:
            s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        s.bind(address(ip, port))
        s.listen(100)
        listeners.append(s)


# Test mixed/DNS-rebound destinations by reconnecting to each concrete answer.
def probe(ip, port, uid):
    pid = os.fork()
    if pid == 0:
        os.setgid(uid)
        os.setuid(uid)
        s = socket.socket(socket.AF_INET6 if ":" in ip else socket.AF_INET)
        s.settimeout(1)
        try:
            s.connect(address(ip, port))
            os._exit(0)
        except OSError:
            os._exit(1)
    return os.waitpid(pid, 0)[1] == 0


# Before policy every destination must actually be reachable.
for ip in v4 + v6:
    assert probe(ip, 443, 12345), "fixture unreachable " + ip
subprocess.run(["nft", "-f", "/test/rules.nft"], check=True)
for ip in v4 + v6:
    expected = ip in [v4[0], v6[0]]
    assert probe(ip, 443, 12345) == expected, "incorrect HTTPS verdict " + ip
    assert probe(ip, 8443, 12345), "other port blocked " + ip
    assert probe(ip, 443, 12346), "other service blocked " + ip
    print(("ALLOW " if expected else "BLOCK ") + ip)
# An IPv4-mapped IPv6 socket must pass through the IPv4 destination rules.
assert probe("::ffff:8.8.8.8", 443, 12345)
assert probe("::ffff:10.1.2.3", 443, 12346)
assert not probe("::ffff:10.1.2.3", 443, 12345)

# Exercise name resolution, not only literal destinations. The same hostname
# first resolves to a permitted address, then to a private address. No URL or
# admission policy changes between requests. /etc/hosts belongs to this
# disposable container, never the host.
with open("/etc/hosts") as hosts:
    original_hosts = hosts.read()
try:
    for ip, expected in [("8.8.8.8", True), ("10.1.2.3", False), ("8.8.8.8", True)]:
        with open("/etc/hosts", "w") as hosts:
            hosts.write(original_hosts + f"\n{ip} metadata-egress.example\n")
        assert probe("metadata-egress.example", 443, 12346), "resolver fixture unreachable"
        assert probe("metadata-egress.example", 443, 12345) == expected, "rebound hostname"
finally:
    with open("/etc/hosts", "w") as hosts:
        hosts.write(original_hosts)
print("PASS: IPv4/IPv6 and mapped destinations, changed hostname resolution, other ports/UIDs")
