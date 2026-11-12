export const SAMPLE_CLIENT = {
  name: 'Sarah Nnadikwe',
  id: '36',
  dob: '1985-04-12',
  ma: '03276736',
};

export async function loadSampleFile(kind) {
  const res = await fetch(`/samples/sample-${kind}.pdf`);
  if (!res.ok) throw new Error(`Sample ${kind} file not found.`);
  const blob = await res.blob();
  return new File([blob], `sample-${kind}.pdf`, { type: 'application/pdf' });
}

export function dispatchSampleFile(kind, file) {
  window.dispatchEvent(new CustomEvent('demo-sample-file', { detail: { kind, file } }));
}
