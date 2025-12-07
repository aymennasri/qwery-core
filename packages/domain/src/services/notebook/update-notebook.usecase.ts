import { Code } from '../../common/code';
import { DomainException } from '../../exceptions';
import { NotebookEntity } from '../../entities';
import { INotebookRepository } from '../../repositories';
import { UpdateNotebookInput, NotebookOutput } from '../../usecases/dto';
import { UpdateNotebookUseCase } from '../../usecases';

export class UpdateNotebookService implements UpdateNotebookUseCase {
  constructor(private readonly notebookRepository: INotebookRepository) {}

  public async execute(
    notebookDTO: UpdateNotebookInput,
  ): Promise<NotebookOutput> {
    const existingNotebook = await this.notebookRepository.findById(
      notebookDTO.id,
    );

    // If notebook doesn't exist, create it (upsert behavior)
    if (!existingNotebook) {
      if (!notebookDTO.projectId) {
        throw DomainException.new({
          code: Code.NOTEBOOK_NOT_FOUND_ERROR,
          overrideMessage: `Notebook with id '${notebookDTO.id}' not found and projectId is required to create it`,
          data: { notebookId: notebookDTO.id },
        });
      }

      // Create new notebook with provided data
      const createInput = {
        projectId: notebookDTO.projectId,
        title: notebookDTO.title || 'Untitled Notebook',
        description: notebookDTO.description,
      };
      const newNotebook = NotebookEntity.create(createInput);
      const createdNotebook = await this.notebookRepository.create(newNotebook);

      // If cells or datasources are provided, update immediately
      if (notebookDTO.cells || notebookDTO.datasources) {
        const updateInput: UpdateNotebookInput = {
          id: createdNotebook.id,
          title: notebookDTO.title,
          description: notebookDTO.description,
          cells: notebookDTO.cells,
          datasources: notebookDTO.datasources,
        };
        const updatedNotebook = NotebookEntity.update(
          createdNotebook,
          updateInput,
        );
        const notebook = await this.notebookRepository.update(updatedNotebook);
        return NotebookOutput.new(notebook);
      }

      return NotebookOutput.new(createdNotebook);
    }

    // Update existing notebook
    const newNotebook = NotebookEntity.update(existingNotebook, notebookDTO);
    const notebook = await this.notebookRepository.update(newNotebook);
    return NotebookOutput.new(notebook);
  }
}
