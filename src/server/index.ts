import {
  type Connection,
  type ConnectionContext,
  Server,
  type WSMessage,
  routePartykitRequest,
} from "partyserver";
import { nanoid } from "nanoid";
import { EventSourceParserStream } from "eventsource-parser/stream";

import {type ChatMessage, type Message, userId} from "../shared";
import {invsy} from "../invsy-client";

export type Env = {
  Ai: Ai;
  INVSY_API_KEY: string;
  INVSY_PROJECT_ID: string;
};

export class Chat extends Server<Env> {
  messages = [] as ChatMessage[];
  chatId = ''

  sendMessage(connection: Connection, message: Message) {
    connection.send(JSON.stringify(message));
  }

  broadcastMessage(message: Message, exclude?: string[]) {
    this.broadcast(JSON.stringify(message), exclude);
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    // Convert the request URL to a URL object
    const url = new URL(ctx.request.url);

    // get the chat id after chat/ and remove the search params e.g. /parties/chat/df7968b702668a6d1f2a51be8c66e25d?test=woop
    const chatId = url.pathname.split("/").pop()?.split("?")[0];

    if (chatId) {
      this.chatId = chatId
      // Fetch the messages from the database
      const { messages } = await invsy(this.env).get(chatId);

      console.log(messages)

      if (messages) {
        this.messages = messages;
      }
    }

    // Send the messages to the connected client
    this.sendMessage(connection, {
      type: "all",
      messages: this.messages,
    });
  }


  async onMessage(connection: Connection, message: WSMessage) {
    // let's broadcast the raw message to everyone else
    this.broadcast(message);

    // let's update our local messages store
    const parsed = JSON.parse(message as string) as Message;

    if (parsed.type === "add") {
      // add the message to the local store
      this.messages.push(parsed);
      // let's ask AI to respond as well for fun
      const aiMessage = {
        id: nanoid(8),
        content: "...",
        user: "AI",
        role: "assistant",
      } as const;

      this.broadcastMessage({
        type: "add",
        ...aiMessage,
      });

      const aiMessageStream = (await this.env.Ai.run(
        "@cf/meta/llama-2-7b-chat-int8",
        {
          stream: true,
          messages: this.messages.map((m) => ({
            content: m.content,
            role: m.role,
          })),
        }
      )) as ReadableStream;

      this.messages.push(aiMessage);

      const eventStream = aiMessageStream
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream());

      // We want the AI to respond to the message in real-time
      // so we're going to stream every chunk as an "update" message

      let buffer = "";

      for await (const event of eventStream) {
        if (event.data !== "[DONE]") {
          // let's append the response to the buffer
          buffer += JSON.parse(event.data).response;
          // and broadcast the buffer as an update
          this.broadcastMessage({
            type: "update",
            ...aiMessage,
            content: buffer + "...", // let's add an ellipsis to show it's still typing
          });
        } else {
          // the AI is done responding
          // we update our local messages store with the final response
          this.messages = this.messages.map((m) => {
            if (m.id === aiMessage.id) {
              return {
                ...m,
                content: buffer,
              };
            }
            return m;
          });

          try {
            const res = await invsy(this.env).save({
              id: this.chatId,
              user_id: userId,
              messages: this.messages,
              meta: {
                title: 'woop the title was updated',
              }
            })

            console.log('res', res)
          } catch (e) {
            console.error(e)
          }

          // let's update the message with the final response
          this.broadcastMessage({
            type: "update",
            ...aiMessage,
            content: buffer,
          });
        }
      }
    } else if (parsed.type === "update") {
      // update the message in the local store
      const index = this.messages.findIndex((m) => m.id === parsed.id);
      this.messages[index] = parsed;
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/new") {
      const { id } = await invsy(env).new({
        title: 'This is a new chat'
      });

      // Redirect to /?id=${id}
      return new Response(null, {
        status: 302,
        headers: {
          location: `${url.href.replace(`/new`, '')}/?id=${id}`,
        },
      });
    }

    return (
        (await routePartykitRequest(request, env)) ||
        new Response("Not Found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;

