import django.db.models.deletion
from django.db import migrations, models

import api.fields


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name='AIProviderConfig',
            fields=[
                ('id',          models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('owner_email', models.EmailField(max_length=254)),
                ('provider',    models.CharField(choices=[('claude', 'Claude'), ('mistral', 'Mistral')], max_length=20)),
                ('api_key',     api.fields.EncryptedTextField(blank=True)),
                ('model_name',  models.CharField(blank=True, max_length=100)),
                ('updated_at',  models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'ai_provider_configs',
                'ordering': ['provider'],
            },
        ),
        migrations.CreateModel(
            name='Robot',
            fields=[
                ('id',          models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('owner_email', models.EmailField(max_length=254)),
                ('name',        models.CharField(max_length=150)),
                ('description', models.TextField(blank=True)),
                ('start_url',   models.URLField()),
                ('steps',       models.JSONField(blank=True, default=list)),
                ('created_at',  models.DateTimeField(auto_now_add=True)),
                ('updated_at',  models.DateTimeField(auto_now=True)),
            ],
            options={
                'db_table': 'robots',
                'ordering': ['-updated_at'],
            },
        ),
        migrations.AlterUniqueTogether(
            name='aiproviderconfig',
            unique_together={('owner_email', 'provider')},
        ),
    ]
