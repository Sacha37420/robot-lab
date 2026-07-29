import django.db.models.deletion
from django.db import migrations, models

import api.models


class Migration(migrations.Migration):

    dependencies = [('api', '0001_initial')]

    operations = [
        migrations.CreateModel(
            name='EngineTicket',
            fields=[
                ('id',          models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('token',       models.CharField(default=api.models._generate_token, max_length=64, unique=True)),
                ('owner_email', models.EmailField(max_length=254)),
                ('created_at',  models.DateTimeField(auto_now_add=True)),
                ('consumed_at', models.DateTimeField(blank=True, null=True)),
                ('robot',       models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='tickets', to='api.robot')),
            ],
            options={
                'db_table': 'engine_tickets',
            },
        ),
    ]
