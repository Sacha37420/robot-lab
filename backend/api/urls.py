from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    AIProviderConfigView, AIStepView, AssistantView, RecordingTicketView, RobotViewSet,
    RunDownloadListView, RunDownloadView, RunTicketView, StepSchemaView, VerifyTicketView,
)

router = DefaultRouter()
router.register('robots', RobotViewSet, basename='robot')

urlpatterns = [
    path('ai-config/<str:provider>/', AIProviderConfigView.as_view()),
    # Vocabulaire d'étapes pour l'éditeur manuel — cf. steps.schema_payload().
    path('step-schema/', StepSchemaView.as_view()),
    path('robots/<int:pk>/recording-ticket/', RecordingTicketView.as_view()),
    path('robots/<int:pk>/run-ticket/', RunTicketView.as_view()),
    path('robots/<int:pk>/assistant/', AssistantView.as_view()),
    path('runs/<int:run_id>/downloads/', RunDownloadListView.as_view()),
    # <path:> et non <str:> : un nom de fichier venu d'un site tiers peut
    # contenir n'importe quoi. Le contrôle de périmètre est fait par
    # downloads.resolve_download(), pas par le routeur.
    path('runs/<int:run_id>/downloads/<path:name>/', RunDownloadView.as_view()),
    path('internal/verify-ticket/', VerifyTicketView.as_view()),
    path('internal/ai-step/', AIStepView.as_view()),
    path('', include(router.urls)),
]
