"""Install pinned tokenizer DATA from DeepSeek's official offline token-count example.

No downloaded Python code is executed. Docker bakes the verified JSON into the Hub image,
so inference and quota admission never need to download tokenizer files at runtime.
"""
import hashlib
import io
from pathlib import Path
import urllib.request
import zipfile

URL = "https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip"
ARCHIVE_SHA256 = "e7310d1dafe0a86d8a5629fe78a7c763760f651db9b8682718a1781dcd6fe495"
TOKENIZER_SHA256 = "89085f12ef79460ac5f66d1119325ddfc694b4ab209d80bbd81d35f081dc9614"
DESTINATION = Path(__file__).resolve().parent / "tokenizers" / "deepseek-v4.json"


def install():
    with urllib.request.urlopen(URL, timeout=60) as response:
        archive = response.read(10_000_001)
    if hashlib.sha256(archive).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError("The official tokenizer archive changed. Review and update its checksum before building.")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        data = bundle.read("deepseek_v4_tokenizer/tokenizer.json")
    if hashlib.sha256(data).hexdigest() != TOKENIZER_SHA256:
        raise RuntimeError("Tokenizer checksum mismatch.")
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    DESTINATION.write_bytes(data)


if __name__ == "__main__":
    install()
