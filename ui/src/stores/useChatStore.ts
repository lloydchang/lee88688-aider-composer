import pick from 'lodash/pick';
import { create } from 'zustand';
import { combine, persist } from 'zustand/middleware';
import { SSE, SSEvent } from 'sse.js';
import {
  ChatAssistantMessage,
  ChatMessage,
  ChatReferenceItem,
  DiffFormat,
  SerializedChatUserMessageChunk,
} from '../types';
import { nanoid } from 'nanoid';
import { logToOutput, showErrorMessage, writeFile } from '../commandApi';
import useExtensionStore from './useExtensionStore';
import { persistStorage } from './lib';

// sse api 返回的类型
type ChatChunkMessage = {
  chunk: string;
};

type ServerChatPayload = {
  chat_type: 'ask' | 'code';
  diff_format: string;
  message: string;
  reference_list: { fs_path: string; readonly: boolean }[];
};

type ChatReferenceItemWithReadOnly = ChatReferenceItem & { readonly?: boolean };

export const useChatSettingStore = create(
  persist(
    combine(
      {
        chatType: 'ask' as 'ask' | 'code',
        diffFormat: DiffFormat.Diff,
      },
      (set) => ({
        setDiffFormat(nextDiffFormat: DiffFormat) {
          set({ diffFormat: nextDiffFormat });
        },
        setChatType(nextChatType: 'ask' | 'code') {
          set({ chatType: nextChatType });
        },
      }),
    ),
    {
      name: 'chat',
      storage: persistStorage,
      partialize: (state) => pick(state, ['chatType', 'diffFormat']),
    },
  ),
);

export const useChatStore = create(
  combine(
    {
      history: [] as ChatMessage[],
      // current assistant message from server
      current: undefined as ChatAssistantMessage | undefined,
      // current chat reference list
      chatReferenceList: [] as ChatReferenceItemWithReadOnly[],
      // current editor file
      currentEditorReference: undefined as
        | ChatReferenceItemWithReadOnly
        | undefined,
    },
    (set, get) => ({
      setHistory(nextHistory: ChatMessage[]) {
        set({ history: nextHistory });
      },
      setCurrentEditorReference(reference: ChatReferenceItemWithReadOnly) {
        set({ currentEditorReference: reference });
      },
      addChatReference(reference: ChatReferenceItemWithReadOnly) {
        set((state) => {
          // if already exists, do nothing
          if (
            state.chatReferenceList.find((r) => r.fsPath === reference.fsPath)
          ) {
            return state;
          }

          return {
            ...state,
            chatReferenceList: [...state.chatReferenceList, reference],
          };
        });
      },
      removeChatReference(reference: ChatReferenceItemWithReadOnly) {
        set((state) => {
          if (state.currentEditorReference?.fsPath === reference.fsPath) {
            return {
              ...state,
              currentEditorReference: undefined,
              chatReferenceList: state.chatReferenceList.filter(
                (r) => r.fsPath !== reference.fsPath,
              ),
            };
          }

          return {
            ...state,
            chatReferenceList: state.chatReferenceList.filter(
              (r) => r.fsPath !== reference.fsPath,
            ),
          };
        });
      },
      clickOnChatReference(reference: ChatReferenceItemWithReadOnly) {
        set((state) => {
          if (state.currentEditorReference?.fsPath === reference.fsPath) {
            return state;
          }

          return {
            ...state,
            chatReferenceList: state.chatReferenceList.map((r) => {
              if (r.fsPath === reference.fsPath) {
                return { ...r, readonly: !r.readonly };
              }
              return r;
            }),
          };
        });
      },
      sendChatMessage(messageChunks: SerializedChatUserMessageChunk[]) {
        const message = messageChunks
          .map((item) =>
            typeof item === 'string' ? item : `\`${item.reference.path}\``,
          )
          .join('');

        const displayText = messageChunks
          .map((item) =>
            typeof item === 'string' ? item : `@${item.reference.name}`,
          )
          .join('');

        logToOutput('info', `sendChatMessage: ${message}`);

        set((state) => {
          return {
            ...state,
            history: [
              ...state.history,
              {
                id: nanoid(),
                text: message,
                displayText,
                type: 'user',
                referenceList: state.chatReferenceList,
              },
            ],
            current: {
              id: nanoid(),
              text: '',
              type: 'assistant',
            },
          };
        });

        let referenceList = get().chatReferenceList.map((item) => ({
          fs_path: item.fsPath,
          readonly: item.readonly ?? false,
        }));
        const currentEditorFsPath = get().currentEditorReference?.fsPath;
        if (currentEditorFsPath) {
          referenceList = referenceList.filter(
            (r) => r.fs_path !== currentEditorFsPath,
          );
          referenceList.push({
            fs_path: currentEditorFsPath,
            readonly: false,
          });
        }

        const { serverUrl } = useExtensionStore.getState();

        const { chatType, diffFormat } = useChatSettingStore.getState();

        const eventSource = new SSE(`${serverUrl}/api/chat`, {
          headers: {
            'Content-Type': 'application/json',
          },
          payload: JSON.stringify({
            chat_type: chatType,
            diff_format: diffFormat,
            message,
            reference_list: referenceList,
          } satisfies ServerChatPayload),
        });

        eventSource.addEventListener('data', (event: { data: string }) => {
          const chunkMessage = JSON.parse(event.data) as ChatChunkMessage;
          set((state) => ({
            ...state,
            current: state.current
              ? {
                  ...state.current,
                  text: (state.current?.text ?? '') + chunkMessage.chunk,
                }
              : state.current,
          }));
        });

        eventSource.addEventListener('usage', (event: { data: string }) => {
          const usage = JSON.parse(event.data) as { usage: string };
          set((state) => ({
            ...state,
            current: state.current
              ? {
                  ...state.current,
                  usage: usage.usage,
                }
              : state.current,
          }));
        });

        eventSource.addEventListener('write', (event: { data: string }) => {
          const writeParams = JSON.parse(event.data) as {
            write: Record<string, string>;
          };

          for (const [path, content] of Object.entries(writeParams.write)) {
            writeFile({ path, content });
          }
        });

        eventSource.addEventListener('end', () => {
          set((state) => {
            const history = state.current
              ? [...state.history, state.current]
              : state.history;
            return {
              ...state,
              history,
              current: undefined,
            };
          });
          eventSource.close();
        });

        eventSource.addEventListener('error', (event: { data: string }) => {
          const errorData = JSON.parse(event.data) as { error: string };
          logToOutput('error', `server error: ${errorData.error}`);
          showErrorMessage(errorData.error);
        });

        eventSource.onerror = (event: SSEvent) => {
          // todo: 应该处理current，目前只在end事件中处理
          console.log('error', event);
          if ((event.target as SSE | null)?.readyState === EventSource.CLOSED) {
            console.log('EventSource connection closed');
            // 处理流结束的逻辑
          } else {
            console.error('EventSource error:', event);
          }
          eventSource.close();
        };
      },
    }),
  ),
);