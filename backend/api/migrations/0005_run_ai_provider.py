from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [('api', '0004_robot_run')]

    operations = [
        migrations.AddField(
            model_name='robotrun',
            name='ai_provider',
            field=models.CharField(
                blank=True,
                choices=[('claude', 'Claude'), ('mistral', 'Mistral')],
                max_length=20,
            ),
        ),
    ]
