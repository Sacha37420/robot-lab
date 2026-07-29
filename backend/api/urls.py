from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import AIProviderConfigView, RobotViewSet

router = DefaultRouter()
router.register('robots', RobotViewSet, basename='robot')

urlpatterns = [
    path('ai-config/<str:provider>/', AIProviderConfigView.as_view()),
    path('', include(router.urls)),
]
