from rest_framework import serializers

from .models import AIProviderConfig, Robot


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


class RobotSerializer(serializers.ModelSerializer):
    class Meta:
        model = Robot
        fields = [
            'id', 'name', 'description', 'start_url', 'steps',
            'created_at', 'updated_at',
        ]
        read_only_fields = ['id', 'steps', 'created_at', 'updated_at']
