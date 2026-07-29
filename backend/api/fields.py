"""Champ de modèle chiffré au repos (Fernet dérivé de SECRET_KEY)."""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken
from django.conf import settings
from django.db import models


def _fernet() -> Fernet:
    key = base64.urlsafe_b64encode(hashlib.sha256(settings.SECRET_KEY.encode()).digest())
    return Fernet(key)


class EncryptedTextField(models.TextField):
    """Chiffre la valeur avant écriture en base et la déchiffre à la lecture.

    Tolère les valeurs déjà stockées en clair (migration douce) : si le
    déchiffrement échoue, la valeur brute est renvoyée telle quelle.
    """

    def get_prep_value(self, value):
        value = super().get_prep_value(value)
        if value in (None, ''):
            return value
        return _fernet().encrypt(value.encode()).decode()

    def from_db_value(self, value, expression, connection):
        if value in (None, ''):
            return value
        try:
            return _fernet().decrypt(value.encode()).decode()
        except (InvalidToken, ValueError):
            return value
