# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Build a reproducible web/mobile benchmark sample from the UEyes test split."""

import argparse
import csv
import io
import json
from pathlib import Path
import random
import urllib.request
import zipfile

ARCHIVE_URL = "https://zenodo.org/records/8010312/files/UEyes_dataset.zip?download=1"
ARCHIVE_SIZE = 12_912_746_325


class RemoteArchive:
    """Fetch ZIP entries by byte range so a pilot needn't download the entire dataset."""

    def __init__(self):
        self.position = 0
        self.cache_start = 0
        self.cache = b""

    def tell(self):
        return self.position

    def seekable(self):
        return True

    def seek(self, offset, whence=io.SEEK_SET):
        origin = {io.SEEK_SET: 0, io.SEEK_CUR: self.position, io.SEEK_END: ARCHIVE_SIZE}[whence]
        self.position = origin + offset
        return self.position

    def read(self, count=-1):
        start = self.position
        count = min(ARCHIVE_SIZE - start, count if count >= 0 else ARCHIVE_SIZE - start)
        if count <= 0:
            return b""
        if start < self.cache_start or start + count > self.cache_start + len(self.cache):
            end = min(ARCHIVE_SIZE, start + max(count, 16_384)) - 1
            # The query string distinguishes byte ranges for HTTP caches.
            request = urllib.request.Request(
                f"{ARCHIVE_URL}&range={start}-{end}", headers={"Range": f"bytes={start}-{end}"},
            )
            with urllib.request.urlopen(request, timeout=60) as response:
                if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{ARCHIVE_SIZE}":
                    raise ValueError("UEyes server did not return the requested archive slice. Use --archive with a local ZIP.")
                self.cache = response.read()
            self.cache_start = start
        offset = start - self.cache_start
        self.position += count
        return self.cache[offset:offset + count]


def prepare(args):
    from PIL import Image

    args.output.mkdir(parents=True, exist_ok=True)
    items = []
    rng = random.Random(args.seed)
    with zipfile.ZipFile(args.archive if args.archive else RemoteArchive()) as archive:
        root = "UEyes_dataset/"
        table = archive.read(root + "image_types.csv").decode("utf-8-sig")
        rows = list(csv.DictReader(io.StringIO(table), delimiter=";"))
        for category in ("web", "mobile"):
            population = sorted({
                row["Image Name"] for row in rows
                if row["Category"].strip().lower() == category and row["Train/Test"].strip().lower() == "test"
            })
            chosen = rng.sample(population, min(args.sample_per_category, len(population)))
            if not chosen:
                raise ValueError(f"No held-out {category} images in the dataset metadata.")
            for original in chosen:
                name = f"{category}-{Path(original).stem}"
                screenshot, fixation = name + ".png", name + "-fixations.png"
                for member, output, mode in (
                    (root + "images/" + original, screenshot, "RGB"),
                    (root + f"saliency_maps/fixmaps_{args.seconds}s/" + original, fixation, "L"),
                ):
                    with Image.open(io.BytesIO(archive.read(member))) as image:
                        image.convert(mode).save(args.output / output)
                items.append({"image": screenshot, "fixations": fixation, "category": category, "source": original})
                print(f"Prepared {name}", flush=True)
    manifest = args.output / "manifest.json"
    manifest.write_text(json.dumps(items, indent=2), encoding="utf-8")
    print(manifest, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Directory for screenshot and fixation PNG pairs")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--archive", type=Path, help="Local UEyes_dataset.zip")
    source.add_argument("--download-sample", action="store_true", help="Download selected entries from Zenodo")
    parser.add_argument("--sample-per-category", type=int, default=12)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--seconds", type=int, choices=[1, 3, 7], default=7)
    args = parser.parse_args()
    if args.sample_per_category < 1:
        parser.error("--sample-per-category must be positive")
    prepare(args)
