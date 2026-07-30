from rest_framework import serializers

from .models import AIProviderConfig, Robot
from .steps import StepError, loop_issues, validate_steps


class AIProviderConfigSerializer(serializers.ModelSerializer):
    """La clé API est en écriture seule : jamais renvoyée déchiffrée au frontend."""

    api_key = serializers.CharField(write_only=True, required=False, allow_blank=True)
    has_key = serializers.SerializerMethodField()

    class Meta:
        model = AIProviderConfig
        fields = ['provider', 'api_key', 'model_name', 'has_key', 'updated_at']
        read_only_fields = ['provider', 'updated_at']

    def get_has_key(self, obj) -> bool:
        return bool(obj.api_key)


class LastRunSerializer(serializers.Serializer):
    """Résumé du dernier test conservé — affiché dans l'éditeur, lu par
    l'assistant (cf. `AssistantView._build_message`, même source de vérité)."""

    status = serializers.CharField()
    status_display = serializers.CharField(source='get_status_display')
    created_at = serializers.DateTimeField()
    finished_at = serializers.DateTimeField()
    log = serializers.JSONField()
    error_message = serializers.CharField()


class RobotSerializer(serializers.ModelSerializer):
    # Avertissements calculés, pas stockés : ils dépendent de la combinaison
    # steps × variables, qui change à chaque modification de l'un ou l'autre.
    warnings = serializers.SerializerMethodField()
    last_run = serializers.SerializerMethodField()

    class Meta:
        model = Robot
        fields = [
            'id', 'name', 'description', 'start_url', 'steps', 'variables',
            'warnings', 'last_run', 'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'created_at', 'updated_at']

    def get_warnings(self, obj) -> list:
        return loop_issues(obj.steps, obj.variables)

    def get_last_run(self, obj):
        run = obj.runs.exclude(status='running').first()
        return LastRunSerializer(run).data if run else None

    def validate_steps(self, value):
        # Même validateur que pour les étapes proposées par l'IA : rien qui ne
        # soit décrit dans steps.py n'entre en base, quelle qu'en soit l'origine.
        try:
            return validate_steps(value)
        except StepError as exc:
            raise serializers.ValidationError(str(exc)) from exc

    def validate_variables(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError('Doit être un objet nom → valeurs.')
        for name, values in value.items():
            if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
                raise serializers.ValidationError(
                    f"Variable « {name} » : doit être une liste de chaînes."
                )
        return value
