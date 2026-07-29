import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [('api', '0003_robot_variables')]

    operations = [
        migrations.CreateModel(
            name='RobotRun',
            fields=[
                ('id',          models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('owner_email', models.EmailField(max_length=254)),
                ('created_at',  models.DateTimeField(auto_now_add=True)),
                ('robot',       models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='runs', to='api.robot')),
            ],
            options={
                'db_table': 'robot_runs',
                'ordering': ['-created_at'],
            },
        ),
        migrations.AddField(
            model_name='engineticket',
            name='mode',
            field=models.CharField(
                choices=[('record', 'Enregistrement'), ('run', 'Exécution')],
                default='record', max_length=10,
            ),
        ),
        migrations.AddField(
            model_name='engineticket',
            name='run',
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                related_name='tickets', to='api.robotrun',
            ),
        ),
    ]
