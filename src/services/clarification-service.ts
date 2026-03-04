import type { DishAnalysis } from '../types';
import type { ClarificationQuestion } from './dialog-state';

const CREAMY_KEYWORDS = ['cake', 'dessert', 'pie', 'tart', 'cheesecake', 'cream', 'mousse', 'tiramisu', 'pudding', 'торт', 'десерт', 'пирог', 'крем'];
const SAUCE_KEYWORDS = ['salad', 'sandwich', 'wrap', 'burger', 'shawarma', 'shawerma', 'сэндвич', 'бургер', 'шаурма', 'салат'];
const OIL_KEYWORDS = ['pasta', 'spaghetti', 'fettuccine', 'penne', 'паста', 'спагетти'];
const COMPLEX_KEYWORDS = ['stew', 'casserole', 'curry', 'soup', 'pizza', 'lasagna', 'risotto', 'pilaf', 'plov', 'borscht', 'суп', 'пицца', 'лазанья', 'ризотто', 'плов', 'борщ', 'рагу', 'запеканка', 'карри'];

export function shouldAskClarification(analysis: DishAnalysis): boolean {
  const dishLower = analysis.dish.toLowerCase();
  const allKeywords = [...CREAMY_KEYWORDS, ...SAUCE_KEYWORDS, ...OIL_KEYWORDS, ...COMPLEX_KEYWORDS];
  if (allKeywords.some((kw) => dishLower.includes(kw))) return true;
  // Для блюд с низкой/средней уверенностью — тоже спрашиваем
  if (analysis.confidence === 'low' || analysis.confidence === 'medium') return true;
  return false;
}

export function generateQuestion(analysis: DishAnalysis): ClarificationQuestion | null {
  const dishLower = analysis.dish.toLowerCase();

  if (CREAMY_KEYWORDS.some((kw) => dishLower.includes(kw))) {
    return {
      id: 'cream',
      text: 'Есть ли крем, сливки или глазурь?',
      options: [
        { label: 'Да', value: 'yes' },
        { label: 'Нет', value: 'no' },
      ],
    };
  }

  if (SAUCE_KEYWORDS.some((kw) => dishLower.includes(kw))) {
    return {
      id: 'sauce',
      text: 'Добавлен ли соус, масло или майонез?',
      options: [
        { label: 'Да', value: 'yes' },
        { label: 'Нет', value: 'no' },
      ],
    };
  }

  if (OIL_KEYWORDS.some((kw) => dishLower.includes(kw))) {
    return {
      id: 'oil',
      text: 'Добавлено ли масло или сливочный соус?',
      options: [
        { label: 'Да', value: 'yes' },
        { label: 'Нет', value: 'no' },
      ],
    };
  }

  if (COMPLEX_KEYWORDS.some((kw) => dishLower.includes(kw))) {
    return {
      id: 'sauce',
      text: 'Добавлен ли соус, масло или сметана?',
      options: [
        { label: 'Да', value: 'yes' },
        { label: 'Нет', value: 'no' },
      ],
    };
  }

  // Fallback для блюд с низкой уверенностью
  if (analysis.confidence === 'low' || analysis.confidence === 'medium') {
    return {
      id: 'sauce',
      text: 'Есть ли в блюде соус, масло или заправка?',
      options: [
        { label: 'Да', value: 'yes' },
        { label: 'Нет', value: 'no' },
      ],
    };
  }

  return null;
}

export function applyCorrection(
  analysis: DishAnalysis,
  answer: string,
  questionId: string
): DishAnalysis {
  const isYes = answer.toLowerCase() === 'yes';
  let calFactor = 1;
  let fatFactor = 1;

  if (questionId === 'cream' && isYes) {
    calFactor = 1.25;
    fatFactor = 1.3;
  } else if (questionId === 'sauce' && isYes) {
    calFactor = 1.2;
    fatFactor = 1.25;
  } else if (questionId === 'oil' && isYes) {
    calFactor = 1.15;
    fatFactor = 1.2;
  }

  const calories = Math.round(analysis.calories * calFactor);
  const fat = Math.round(analysis.fat * fatFactor);
  const protein = analysis.protein;
  const carbs = analysis.carbs;
  const calories_range = {
    min: Math.round(analysis.calories_range.min * calFactor),
    max: Math.round(analysis.calories_range.max * calFactor),
  };

  return {
    ...analysis,
    calories,
    fat,
    protein,
    carbs,
    calories_range,
  };
}
