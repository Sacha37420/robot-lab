"""Accès aux fichiers téléchargés par un robot pendant une exécution.

Les fichiers sont écrits par `engine/` dans `<ROOT>/<run_id>/` et lus ici. Le nom
du fichier vient donc d'un site tiers, via le robot : il est **hostile par
construction** et ne doit jamais être concaténé naïvement à un chemin.
`resolve_download()` est le seul point d'accès, et il refuse tout chemin qui
sortirait du dossier du run (`..`, chemin absolu, lien symbolique).
"""
from pathlib import Path

from django.conf import settings


def run_dir(run_id) -> Path:
    return Path(settings.ROBOT_DOWNLOAD_ROOT) / str(run_id)


def list_downloads(run_id):
    """Fichiers encore présents pour ce run (les récupérés ont été supprimés).

    Passe par `resolve_download()` plutôt que de lister brut : la liste annonce
    ainsi exactement ce qui est réellement récupérable — un lien symbolique
    pointant hors du run est refusé au téléchargement, il n'a rien à faire ici.
    """
    directory = run_dir(run_id)
    if not directory.is_dir():
        return []

    files = []
    for entry in directory.iterdir():
        resolved = resolve_download(run_id, entry.name)
        if resolved is not None:
            files.append({'name': entry.name, 'size': resolved.stat().st_size})
    return sorted(files, key=lambda item: item['name'])


def resolve_download(run_id, name) -> Path | None:
    """Chemin réel d'un fichier de ce run, ou None si le nom est hors périmètre.

    Le contrôle porte sur le chemin **résolu** (liens symboliques compris) : un
    contrôle sur la chaîne seule laisserait passer un lien déposé par un site
    malveillant via le nom du fichier téléchargé.
    """
    directory = run_dir(run_id)
    try:
        resolved_dir = directory.resolve(strict=True)
        candidate = (directory / name).resolve(strict=True)
    except (OSError, RuntimeError):
        return None

    if not candidate.is_file():
        return None
    if candidate.parent != resolved_dir:
        return None
    return candidate
