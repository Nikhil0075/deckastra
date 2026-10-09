"""Publish reproducible, OFL-licensed CJK packs from a pinned upstream commit."""
import hashlib
import io
import json
from pathlib import Path
from urllib.request import urlopen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from bootstrap import Cloud

COMMIT = "523d033d6cb47f4a80c58a35753646f5c3608a78"
BASE = f"https://raw.githubusercontent.com/notofonts/noto-cjk/{COMMIT}/Sans"
ROOT = Path(__file__).resolve().parents[2]


def main():
    directory = Path(__file__).parent / "state" / "font-packs"
    directory.mkdir(parents=True, exist_ok=True)
    license_bytes = urlopen(f"https://raw.githubusercontent.com/notofonts/noto-cjk/{COMMIT}/LICENSE", timeout=60).read()
    (directory / "OFL.txt").write_bytes(license_bytes)
    catalog = {}
    for script, suffix in (("japanese", "JP"), ("korean", "KR"), ("chinese", "SC"), ("chinese-traditional", "TC")):
        source = urlopen(BASE + f"/Variable/TTF/Subset/NotoSans{suffix}-VF.ttf", timeout=90).read()
        files = []
        for weight in (400, 700):
            font = TTFont(io.BytesIO(source))
            static = instantiateVariableFont(font, {"wght": weight}, inplace=True)
            static.flavor = "woff2"
            filename = f"{script}-{weight}.woff2"
            output = directory / filename
            static.save(output)
            payload = output.read_bytes()
            files.append({"name": filename, "bytes": len(payload), "sha256": hashlib.sha256(payload).hexdigest(), "weight": weight})
        catalog[script] = {"family": "Noto Sans " + ("SC" if suffix == "TC" else suffix), "license": "SIL Open Font License 1.1", "source_commit": COMMIT,
            "source_sha256": hashlib.sha256(source).hexdigest(), "files": files}
    target = ROOT / "packages" / "renderer" / "font-packs" / "catalog.json"
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(catalog, indent=2), encoding="utf-8")
    (target.parent / "OFL.txt").write_bytes(license_bytes)
    for project in ("deckastra", "deckastra-prod"):
        cloud = Cloud(project, "asia-south1", "deckastra")
        for file in [*directory.glob("*.woff2"), directory / "OFL.txt", target]:
            cloud.run("storage", "cp", str(file), f"gs://{project}-packs/fonts/noto-cjk-2.004/{file.name}")
        for service in ("api", "export-worker"):
            cloud.run("storage", "buckets", "add-iam-policy-binding", f"gs://{project}-packs", f"--member=serviceAccount:deckastra-{service}@{project}.iam.gserviceaccount.com", "--role=roles/storage.objectViewer")
    print("Published four CJK packs with two static weights, SHA-256 manifests and OFL notice.")


if __name__ == "__main__": main()
