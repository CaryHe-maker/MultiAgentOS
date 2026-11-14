"""Where an uploaded avatar is stored: <root>/<user>/<file name>."""
import os

ALLOWED = (".png", ".jpg", ".jpeg", ".gif")


def avatar_path(root: str, user: str, filename: str) -> str:
    if not filename.lower().endswith(ALLOWED):
        raise ValueError("not an image")
    base = os.path.realpath(root)
    path = os.path.realpath(os.path.join(base, user, filename))
    if os.path.dirname(os.path.dirname(path)) != base or os.path.isabs(filename) or os.path.isabs(user):
        raise ValueError("the file must stay inside the upload folder")
    return os.path.join(root, user, filename)


def save_avatar(root: str, user: str, filename: str, data: bytes) -> str:
    path = avatar_path(root, user, filename)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(data)
    return path
