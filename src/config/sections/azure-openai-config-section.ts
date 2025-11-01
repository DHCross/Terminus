import * as vscode from 'vscode';
import { AzureOpenAIConfig } from '../../types/configuration';

export class AzureOpenAISection {
  read(): AzureOpenAIConfig {
    const c = vscode.workspace.getConfiguration('agentvoice.azureOpenAI');
    return {
      endpoint: c.get('endpoint', ''),
      deploymentName: c.get('deploymentName', 'gpt-4o-realtime-preview'),
      apiVersion: c.get('apiVersion', '2025-04-01-preview')
    };
  }
}
