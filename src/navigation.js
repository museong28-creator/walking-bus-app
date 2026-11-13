// Advisory maneuvers, not heading/compass instructions. No generated geometry.
export function nextManeuver(route, progress) {
  if (!route?.steps?.length || !progress || !Number.isFinite(progress.remaining)) return null;
  const travelled = route.distance - progress.remaining;
  const step = route.steps.find(s => s.type !== 'depart' && s.at >= travelled - 8);
  if (!step) return null;
  const directions = {left:'왼쪽',right:'오른쪽','slight left':'완만한 왼쪽','slight right':'완만한 오른쪽','sharp left':'급한 왼쪽','sharp right':'급한 오른쪽',straight:'직진',uturn:'되돌아가는 방향'};
  let instruction;
  if (step.type === 'arrive') instruction = '목적지 부근 · 실제 입구 확인';
  else if (/roundabout|rotary/.test(step.type)) instruction = '회전교차로 · 지도와 현장 표지 확인';
  else if (step.type === 'end of road') instruction = `길 끝에서 ${directions[step.modifier] || '지도 방향'}으로 이동`;
  else if (directions[step.modifier]) instruction = step.modifier === 'straight' ? '직진' : `${directions[step.modifier]}으로 이동`;
  else instruction = '지도에 표시된 경로 확인';
  return {instruction,name:step.name,meters:Math.max(0,step.at-travelled)};
}
