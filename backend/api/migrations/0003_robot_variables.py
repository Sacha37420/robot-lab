from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [('api', '0002_engine_ticket')]

    operations = [
        migrations.AddField(
            model_name='robot',
            name='variables',
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
