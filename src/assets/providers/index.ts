import anthropic from './anthropic.svg';
import openai from './openai.svg';
import google from './google.svg';
import openrouter from './openrouter.svg';
import ark from './ark.svg';
import deepseek from './deepseek.svg';
import moonshot from './moonshot.svg';
import siliconflow from './siliconflow.svg';
import minimaxPortal from './minimax.svg';
import qwenPortal from './qwen.svg';
import ollama from './ollama.svg';
import custom from './custom.svg';
import lyModel from '../../../resources/icons/512x512.png';

export const providerIcons: Record<string, string> = {
    'ly-minimax': lyModel,
    anthropic,
    openai,
    google,
    openrouter,
    ark,
    deepseek,
    moonshot,
    'moonshot-global': moonshot,
    siliconflow,
    'minimax-portal': minimaxPortal,
    'minimax-portal-cn': minimaxPortal,
    'ly-mimo': lyModel,
    'ly-deepseek': lyModel,
    // 'ly-glm': lyModel,
    'modelstudio': qwenPortal,
    ollama,
    custom,
};
