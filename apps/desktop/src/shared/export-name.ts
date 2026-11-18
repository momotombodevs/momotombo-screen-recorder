import { activeVariant, type ID, type Project } from '@momotombo/project-model';

export function exportBaseName(project: Project, variantId: ID): string {
  return `${project.name} ${activeVariant(project, variantId).name.replace(':', 'x')}`;
}
