export const SAMPLE_CLIENT = {
  name: 'Jane Doe',
  id: '9999',
  dob: '1990-01-01',
  ma_number: '12345678',
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
