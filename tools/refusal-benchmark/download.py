"""Download public model artifacts only; never read chat history."""

from huggingface_hub import snapshot_download
from models import MODELS

for name, (repository, revision) in MODELS.items():
    print(
        name,
        snapshot_download(
            repository,
            revision=revision,
            allow_patterns=[
                "*.json",
                "*.safetensors",
                "*.txt",
                "README.md",
                "LICENSE",
            ],
        ),
        flush=True,
    )
