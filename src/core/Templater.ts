import {
    MarkdownPostProcessorContext,
    MarkdownView,
    normalizePath,
    TAbstractFile,
    TFile,
    TFolder,
} from "obsidian";
import {
    delay,
    generate_dynamic_command_regex,
    get_active_file,
    resolve_tfile,
} from "utils/Utils";
import TemplaterPlugin from "main";
import {
    FunctionsGenerator,
    FunctionsMode,
} from "./functions/FunctionsGenerator";
import { errorWrapper, errorWrapperSync, TemplaterError } from "utils/Error";
import { Parser } from "./parser/Parser";
import { log_error } from "utils/Log";

export enum RunMode {
    CreateNewFromTemplate,
    AppendActiveFile,
    OverwriteFile,
    OverwriteActiveFile,
    DynamicProcessor,
    StartupTemplate,
}

export type RunningConfig = {
    template_file: TFile | undefined;
    target_file: TFile;
    run_mode: RunMode;
    active_file?: TFile | null;
};

export class Templater {
    public parser: Parser;
    public functions_generator: FunctionsGenerator;
    public current_functions_object: Record<string, unknown>;
    private templater_task_counter: number;

    constructor(private plugin: TemplaterPlugin) {
        this.functions_generator = new FunctionsGenerator(this.plugin);
        this.parser = new Parser();
    }

    async setup(): Promise<void> {
        this.templater_task_counter = 0;
        await this.parser.init();
        await this.functions_generator.init();
        this.plugin.registerMarkdownPostProcessor((el, ctx) =>
            this.process_dynamic_templates(el, ctx)
        );
    }

    create_running_config(
        template_file: TFile | undefined,
        target_file: TFile,
        run_mode: RunMode
    ): RunningConfig {
        const active_file = get_active_file(app);

        return {
            template_file: template_file,
            target_file: target_file,
            run_mode: run_mode,
            active_file: active_file,
        };
    }

    async read_and_parse_template(config: RunningConfig): Promise<string> {
        const template_content = await app.vault.read(
            config.template_file as TFile
        );
        return this.parse_template(config, template_content);
    }

    async parse_template(
        config: RunningConfig,
        template_content: string
    ): Promise<string> {
        const functions_object = await this.functions_generator.generate_object(
            config,
            FunctionsMode.USER_INTERNAL
        );
        this.current_functions_object = functions_object;
        const content = await this.parser.parse_commands(
            template_content,
            functions_object
        );
        return content;
    }

    private start_templater_task() {
        this.templater_task_counter++;
    }

    private async end_templater_task() {
        this.templater_task_counter--;
        if (this.templater_task_counter === 0) {
            app.workspace.trigger("templater:all-templates-executed");
            await this.functions_generator.teardown();
        }
    }

    async create_new_note_from_template(
        template: TFile | string,
        folder?: TFolder,
        filename?: string,
        open_new_note = true
    ): Promise<TFile | undefined> {
        this.start_templater_task();
        // TODO: Maybe there is an obsidian API function for that
        if (!folder) {
            const new_file_location = app.vault.getConfig("newFileLocation");
            switch (new_file_location) {
                case "current": {
                    const active_file = get_active_file(app);
                    if (active_file) {
                        folder = active_file.parent;
                    }
                    break;
                }
                case "folder":
                    folder = app.fileManager.getNewFileParent("");
                    break;
                case "root":
                    folder = app.vault.getRoot();
                    break;
                default:
                    break;
            }
        }

        const extension =
            template instanceof TFile ? template.extension || "md" : "md";
        const created_note = await errorWrapper(async () => {
            const path = app.vault.getAvailablePath(
                normalizePath(
                    `${folder?.path ?? ""}/${filename ?? "Untitled"}`
                ),
                extension
            );
            return app.vault.create(path, "");
        }, `Couldn't create ${extension} file.`);

        if (created_note == null) {
            await this.end_templater_task();
            return;
        }

        let running_config: RunningConfig;
        let output_content: string;
        if (template instanceof TFile) {
            running_config = this.create_running_config(
                template,
                created_note,
                RunMode.CreateNewFromTemplate
            );
            output_content = await errorWrapper(
                async () => this.read_and_parse_template(running_config),
                "Template parsing error, aborting."
            );
        } else {
            running_config = this.create_running_config(
                undefined,
                created_note,
                RunMode.CreateNewFromTemplate
            );
            output_content = await errorWrapper(
                async () => this.parse_template(running_config, template),
                "Template parsing error, aborting."
            );
        }

        if (output_content == null) {
            await app.vault.delete(created_note);
            await this.end_templater_task();
            return;
        }

        await app.vault.modify(created_note, output_content);

        app.workspace.trigger("templater:new-note-from-template", {
            file: created_note,
            content: output_content,
        });

        if (open_new_note) {
            const active_leaf = app.workspace.getLeaf(false);
            if (!active_leaf) {
                log_error(new TemplaterError("No active leaf"));
                return;
            }
            await active_leaf.openFile(created_note, {
                state: { mode: "source" },
            });

            await this.plugin.editor_handler.jump_to_next_cursor_location(
                created_note,
                true
            );

            active_leaf.setEphemeralState({
                rename: "all",
            });
        }

        await this.end_templater_task();
        return created_note;
    }

    async append_template_to_active_file(template_file: TFile): Promise<void> {
        this.start_templater_task();
        const active_view = app.workspace.getActiveViewOfType(MarkdownView);
        const active_editor = app.workspace.activeEditor;
        if (!active_editor || !active_editor.file || !active_editor.editor) {
            log_error(
                new TemplaterError("No active editor, can't append templates.")
            );
            await this.end_templater_task();
            return;
        }
        const running_config = this.create_running_config(
            template_file,
            active_editor.file,
            RunMode.AppendActiveFile
        );
        const output_content = await errorWrapper(
            async () => this.read_and_parse_template(running_config),
            "Template parsing error, aborting."
        );
        // errorWrapper failed
        if (output_content == null) {
            await this.end_templater_task();
            return;
        }

        const editor = active_editor.editor;
        const doc = editor.getDoc();
        const oldSelections = doc.listSelections();
        doc.replaceSelection(output_content);

        app.workspace.trigger("templater:template-appended", {
            view: active_view,
            editor: active_editor,
            content: output_content,
            oldSelections,
            newSelections: doc.listSelections(),
        });

        await this.plugin.editor_handler.jump_to_next_cursor_location(
            active_editor.file,
            true
        );
        await this.end_templater_task();
    }

    async write_template_to_file(
        template_file: TFile,
        file: TFile
    ): Promise<void> {
        this.start_templater_task();
        const active_editor = app.workspace.activeEditor;
        const active_file = get_active_file(app);
        const running_config = this.create_running_config(
            template_file,
            file,
            RunMode.OverwriteFile
        );
        const output_content = await errorWrapper(
            async () => this.read_and_parse_template(running_config),
            "Template parsing error, aborting."
        );
        // errorWrapper failed
        if (output_content == null) {
            return;
        }
        await app.vault.modify(file, output_content);
        // Set cursor to first line of editor (below properties)
        // https://github.com/SilentVoid13/Templater/issues/1231
        if (
            active_file?.path === file.path &&
            active_editor &&
            active_editor.editor
        ) {
            const editor = active_editor.editor;
            editor.setSelection({ line: 0, ch: 0 }, { line: 0, ch: 0 });
        }
        app.workspace.trigger("templater:new-note-from-template", {
            file,
            content: output_content,
        });
        await this.plugin.editor_handler.jump_to_next_cursor_location(
            file,
            true
        );
        await this.end_templater_task();
    }

    overwrite_active_file_commands(): void {
        const active_editor = app.workspace.activeEditor;
        if (!active_editor || !active_editor.file) {
            log_error(
                new TemplaterError(
                    "Active editor is null, can't overwrite content"
                )
            );
            return;
        }
        this.overwrite_file_commands(active_editor.file, true);
    }

    async overwrite_file_commands(
        file: TFile,
        active_file = false
    ): Promise<void> {
        this.start_templater_task();
        const running_config = this.create_running_config(
            file,
            file,
            active_file ? RunMode.OverwriteActiveFile : RunMode.OverwriteFile
        );
        const output_content = await errorWrapper(
            async () => this.read_and_parse_template(running_config),
            "Template parsing error, aborting."
        );
        // errorWrapper failed
        if (output_content == null) {
            await this.end_templater_task();
            return;
        }
        await app.vault.modify(file, output_content);
        app.workspace.trigger("templater:overwrite-file", {
            file,
            content: output_content,
        });
        await this.plugin.editor_handler.jump_to_next_cursor_location(
            file,
            true
        );
        await this.end_templater_task();
    }

    async process_dynamic_templates(
        el: HTMLElement,
        ctx: MarkdownPostProcessorContext
    ): Promise<void> {
        const dynamic_command_regex = generate_dynamic_command_regex();

        const walker = document.createNodeIterator(el, NodeFilter.SHOW_TEXT);
        let node;
        let pass = false;
        let functions_object: Record<string, unknown>;
        while ((node = walker.nextNode())) {
            let content = node.nodeValue;
            if (content !== null) {
                let match = dynamic_command_regex.exec(content);
                if (match !== null) {
                    const file = app.metadataCache.getFirstLinkpathDest(
                        "",
                        ctx.sourcePath
                    );
                    if (!file || !(file instanceof TFile)) {
                        return;
                    }
                    if (!pass) {
                        pass = true;
                        const config = this.create_running_config(
                            file,
                            file,
                            RunMode.DynamicProcessor
                        );
                        functions_object =
                            await this.functions_generator.generate_object(
                                config,
                                FunctionsMode.USER_INTERNAL
                            );
                        this.current_functions_object = functions_object;
                    }
                }

                while (match != null) {
                    // Not the most efficient way to exclude the '+' from the command but I couldn't find something better
                    const complete_command = match[1] + match[2];
                    const command_output: string = await errorWrapper(
                        async () => {
                            return await this.parser.parse_commands(
                                complete_command,
                                functions_object
                            );
                        },
                        `Command Parsing error in dynamic command '${complete_command}'`
                    );
                    if (command_output == null) {
                        return;
                    }
                    const start =
                        dynamic_command_regex.lastIndex - match[0].length;
                    const end = dynamic_command_regex.lastIndex;
                    content =
                        content.substring(0, start) +
                        command_output +
                        content.substring(end);

                    dynamic_command_regex.lastIndex +=
                        command_output.length - match[0].length;
                    match = dynamic_command_regex.exec(content);
                }
                node.nodeValue = content;
            }
        }
    }

    get_new_file_template_for_folder(folder: TFolder): string | undefined {
        do {
            const match = this.plugin.settings.folder_templates.find(
                (e) => e.folder == folder.path
            );

            if (match && match.template) {
                return match.template;
            }

            folder = folder.parent;
        } while (folder);
    }

    static async on_file_creation(
        templater: Templater,
        file: TAbstractFile
    ): Promise<void> {
        if (!(file instanceof TFile) || file.extension !== "md") {
            return;
        }

        // Avoids template replacement when syncing template files
        const template_folder = normalizePath(
            templater.plugin.settings.templates_folder
        );
        if (file.path.includes(template_folder) && template_folder !== "/") {
            return;
        }

        // TODO: find a better way to do this
        // Currently, I have to wait for the note extractor plugin to add the file content before replacing
        await delay(300);

        if (
            file.stat.size == 0 &&
            templater.plugin.settings.enable_folder_templates
        ) {
            const folder_template_match =
                templater.get_new_file_template_for_folder(file.parent);
            if (!folder_template_match) {
                return;
            }
            const template_file: TFile = await errorWrapper(
                async (): Promise<TFile> => {
                    return resolve_tfile(folder_template_match);
                },
                `Couldn't find template ${folder_template_match}`
            );
            // errorWrapper failed
            if (template_file == null) {
                return;
            }
            await templater.write_template_to_file(template_file, file);
        } else {
            if (file.stat.size <= 100000) {
                //https://github.com/SilentVoid13/Templater/issues/873
                await templater.overwrite_file_commands(file);
            } else {
                console.log(
                    `Templater skipped parsing ${file.path} because file size exceeds 10000`
                );
            }
        }
    }

    async execute_startup_scripts(): Promise<void> {
        for (const template of this.plugin.settings.startup_templates) {
            if (!template) {
                continue;
            }
            const file = errorWrapperSync(
                () => resolve_tfile(template),
                `Couldn't find startup template "${template}"`
            );
            if (!file) {
                continue;
            }
            this.start_templater_task();
            const running_config = this.create_running_config(
                file,
                file,
                RunMode.StartupTemplate
            );
            await errorWrapper(
                async () => this.read_and_parse_template(running_config),
                `Startup Template parsing error, aborting.`
            );
            await this.end_templater_task();
        }
    }
}
