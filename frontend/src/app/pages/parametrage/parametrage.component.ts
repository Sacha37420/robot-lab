import { Component, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { ApiService, AIProvider, AIProviderConfig } from '../../core/api.service';

interface ProviderCard {
  provider: AIProvider;
  label: string;
  modelPlaceholder: string;
  config: AIProviderConfig | null;
  apiKeyInput: string;
  modelNameInput: string;
  saving: boolean;
  error: string | null;
  saved: boolean;
}

const PROVIDERS: Array<Pick<ProviderCard, 'provider' | 'label' | 'modelPlaceholder'>> = [
  { provider: 'claude', label: 'Claude (Anthropic)', modelPlaceholder: 'ex. claude-sonnet-5' },
  { provider: 'mistral', label: 'Mistral', modelPlaceholder: 'ex. mistral-large-latest' },
];

@Component({
  selector: 'app-parametrage',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './parametrage.component.html',
  styleUrl: './parametrage.component.scss',
})
export class ParametrageComponent implements OnInit {
  private api = inject(ApiService);

  cards = signal<ProviderCard[]>(
    PROVIDERS.map(p => ({
      ...p,
      config: null,
      apiKeyInput: '',
      modelNameInput: '',
      saving: false,
      error: null,
      saved: false,
    })),
  );

  ngOnInit(): void {
    for (const card of this.cards()) {
      this.api.getAiConfig(card.provider).subscribe({
        next: (config) => {
          this.patchCard(card.provider, {
            config,
            modelNameInput: config.model_name,
          });
        },
        error: () => {
          this.patchCard(card.provider, { error: 'Impossible de charger la configuration.' });
        },
      });
    }
  }

  save(provider: AIProvider): void {
    const card = this.cards().find(c => c.provider === provider);
    if (!card) return;

    this.patchCard(provider, { saving: true, error: null, saved: false });
    this.api.saveAiConfig(provider, {
      api_key: card.apiKeyInput || undefined,
      model_name: card.modelNameInput,
    }).subscribe({
      next: (config) => {
        this.patchCard(provider, { config, apiKeyInput: '', saving: false, saved: true });
      },
      error: () => {
        this.patchCard(provider, { saving: false, error: "Échec de l'enregistrement." });
      },
    });
  }

  private patchCard(provider: AIProvider, changes: Partial<ProviderCard>): void {
    this.cards.update(cards =>
      cards.map(c => (c.provider === provider ? { ...c, ...changes } : c)),
    );
  }
}
