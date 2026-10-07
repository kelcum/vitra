"""Builds the Vitra Cosmetics mod jar that Vitra adds to Fabric instances.

    python scripts/build-cosmetics-mod.py [minecraft version]

Minecraft 26.x ships with readable (unobfuscated) names, so the mod compiles straight against the
game jar and its libraries: no Gradle or remapping. The game and Fabric Loader must already be
installed in Vitra's data folder (launch a Fabric instance of that version once). Needs a JDK 25;
set JAVA_HOME or keep one in ~/.cache/jdk.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
MOD = os.path.join(ROOT, "mods", "vitra-cosmetics")
DATA = os.path.expanduser("~/.cache/vitra-data")
MC = sys.argv[1] if len(sys.argv) > 1 else "26.3"
VERSION = "1.1.0"


def jdk_tool(name):
    homes = [os.environ.get("JAVA_HOME", "")] + sorted(glob.glob(os.path.expanduser("~/.cache/jdk/jdk-25*")), reverse=True)
    for home in homes:
        exe = os.path.join(home, "bin", name + (".exe" if os.name == "nt" else ""))
        if home and os.path.exists(exe):
            return exe
    sys.exit(f"No JDK with {name} found. Set JAVA_HOME to a JDK 25.")


def maven_path(coords):
    group, artifact, version = coords.split(":")[:3]
    return os.path.join(group.replace(".", os.sep), artifact, version, f"{artifact}-{version}.jar")


def classpath():
    game = json.load(open(os.path.join(DATA, "versions", MC, f"{MC}.json"), encoding="utf-8"))
    jars = [os.path.join(DATA, "versions", MC, f"{MC}.jar")]
    for lib in game["libraries"]:
        art = lib.get("downloads", {}).get("artifact")
        if art:
            jars.append(os.path.join(DATA, "libraries", art["path"]))
    fabric = sorted(glob.glob(os.path.join(DATA, "versions", f"fabric-loader-*-{MC}", "*.json")))
    if not fabric:
        sys.exit(f"Fabric Loader for {MC} isn't installed in {DATA}. Launch a Fabric {MC} instance once.")
    for lib in json.load(open(fabric[-1], encoding="utf-8"))["libraries"]:
        jars.append(os.path.join(DATA, "libraries", maven_path(lib["name"])))
    if not os.path.exists(jars[0]):
        sys.exit(f"Minecraft {MC} isn't installed in {DATA}. Launch an instance of it once.")
    return [j for j in jars if os.path.exists(j)]   # libraries for other operating systems aren't installed, and aren't needed


def main():
    out = os.path.join(MOD, "build")
    classes = os.path.join(out, "classes")
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(classes)
    sources = glob.glob(os.path.join(MOD, "src", "main", "java", "**", "*.java"), recursive=True)
    subprocess.run([jdk_tool("javac"), "--release", "25", "-proc:none", "-encoding", "UTF-8", "-Xlint:-options",
                    "-d", classes, "-cp", os.pathsep.join(classpath()), *sources], check=True)

    jar = os.path.join(out, f"vitra-cosmetics-{VERSION}+{MC}.jar")
    res = os.path.join(MOD, "src", "main", "resources")
    with zipfile.ZipFile(jar, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n\r\n")
        for base in (classes, res):
            for path in sorted(glob.glob(os.path.join(base, "**", "*"), recursive=True)):
                if os.path.isdir(path):
                    continue
                name = os.path.relpath(path, base).replace(os.sep, "/")
                if name == "fabric.mod.json":
                    z.writestr(name, open(path, encoding="utf-8").read().replace("${version}", f"{VERSION}+{MC}"))
                else:
                    z.write(path, name)

    dest = os.path.join(ROOT, "src-tauri", "resources", "mods")
    os.makedirs(dest, exist_ok=True)
    shutil.copy(jar, os.path.join(dest, f"vitra-cosmetics-{MC}.jar"))
    print(f"built {os.path.relpath(jar, ROOT)} ({os.path.getsize(jar) // 1024} KB), copied to src-tauri/resources/mods/")


if __name__ == "__main__":
    main()
