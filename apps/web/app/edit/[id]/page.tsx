import { EditorPage } from "./EditorPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EditorPage presentationId={id} />;
}
