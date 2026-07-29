"""Appel du fournisseur IA choisi, avec la clé de l'utilisateur courant.

Une seule fonction publique : `complete_json()`. Chaque fournisseur a son SDK,
mais l'appelant ne voit qu'un dict validé — les différences (sorties structurées
côté Anthropic, `json_object` côté Mistral) sont absorbées ici.

La clé n'est jamais loggée ni renvoyée : elle est lue en base (chiffrée au repos,
cf. `fields.EncryptedTextField`) juste avant l'appel.
"""
import json
import time

from .models import AIProviderConfig

DEFAULT_MODELS = {
    'claude': 'claude-opus-5',
    'mistral': 'mistral-large-latest',
}

MAX_TOKENS = 16000
# Le rate limit se dégage vite ; inutile d'attendre longtemps, mais il faut attendre.
RETRY_DELAYS = [3, 10]


class AINotConfigured(Exception):
    """Aucune clé enregistrée pour ce fournisseur (message affiché tel quel)."""


class AIError(Exception):
    """Échec de l'appel — message affiché tel quel à l'utilisateur."""


def _config(owner_email, provider):
    if provider not in DEFAULT_MODELS:
        raise AIError(f"Fournisseur inconnu : « {provider} ».")
    try:
        config = AIProviderConfig.objects.get(owner_email=owner_email, provider=provider)
    except AIProviderConfig.DoesNotExist:
        config = None
    if config is None or not config.api_key:
        raise AINotConfigured(
            f"Aucune clé {provider} enregistrée — allez dans Paramétrage pour l'ajouter."
        )
    return config


def _is_transient(exc):
    """429 (rate limit) et 5xx méritent une nouvelle tentative. Une clé invalide, non."""
    text = str(exc)
    return any(code in text for code in ('429', '500', '502', '503', '504', 'timeout', 'Timeout'))


def _call_claude(api_key, model, system, message, schema):
    import anthropic  # import tardif : dépendance lourde, inutile hors assistant

    client = anthropic.Anthropic(api_key=api_key)
    response = client.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{'role': 'user', 'content': message}],
        output_config={'format': {'type': 'json_schema', 'schema': schema}},
    )

    # `stop_reason` se lit AVANT `content` : sur un refus le contenu est vide,
    # et sur max_tokens il est tronqué — donc pas du JSON valide.
    if response.stop_reason == 'refusal':
        raise AIError("Le modèle a refusé de traiter cette demande.")
    if response.stop_reason == 'max_tokens':
        raise AIError(
            "La réponse a été tronquée (parcours trop long). "
            "Essayez une demande plus ciblée."
        )

    text = next((b.text for b in response.content if b.type == 'text'), '')
    if not text:
        raise AIError("Le modèle n'a renvoyé aucun contenu.")
    return text


def _mistral_class():
    """Le SDK Mistral a déplacé la classe en 2.x : `mistralai.client.Mistral`.
    En 1.x elle était à la racine (c'est encore la forme utilisée par
    `restauration`). On accepte les deux plutôt que d'épingler une version.
    """
    try:
        from mistralai.client import Mistral
    except ImportError:
        from mistralai import Mistral
    return Mistral


def _call_mistral(api_key, model, system, message, schema):
    Mistral = _mistral_class()  # import tardif : dépendance lourde

    client = Mistral(api_key=api_key)
    response = client.chat.complete(
        model=model,
        messages=[
            # Mistral n'a pas de sorties structurées par schéma : le schéma est
            # décrit dans le prompt, et `json_object` garantit au moins du JSON.
            {'role': 'system', 'content': f'{system}\n\nRéponds en JSON respectant ce schéma :\n'
                                          f'{json.dumps(schema, ensure_ascii=False)}'},
            {'role': 'user', 'content': message},
        ],
        response_format={'type': 'json_object'},
        temperature=0,
    )
    return response.choices[0].message.content or ''


_CALLERS = {'claude': _call_claude, 'mistral': _call_mistral}


def complete_json(owner_email, provider, system, message, schema):
    """Appelle le fournisseur et renvoie la réponse JSON désérialisée."""
    config = _config(owner_email, provider)
    model = config.model_name.strip() or DEFAULT_MODELS[provider]
    caller = _CALLERS[provider]

    last_error = None
    for delay in RETRY_DELAYS + [None]:
        try:
            raw = caller(config.api_key, model, system, message, schema)
            break
        except AIError:
            raise
        except Exception as exc:                    # noqa: BLE001 — SDK tiers, erreurs hétérogènes
            last_error = exc
            if delay is None or not _is_transient(exc):
                raise AIError(f'Appel {provider} en échec : {exc}') from exc
            time.sleep(delay)
    else:
        raise AIError(f'Appel {provider} en échec : {last_error}')

    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AIError(f'Réponse {provider} illisible (JSON invalide) : {exc}') from exc
