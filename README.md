# F.D.P. Online

Jogo de cartas no estilo F.D.P. (Foi de Propósito) para jogar no navegador com os amigos, de 4 a 12 pessoas. Funciona no celular e no computador. Para maiores de 18.

Não tem nenhuma dependência: só precisa do [Node.js](https://nodejs.org) 18 ou mais novo.

## Rodar no seu computador

```bash
node server.js
```

## Regras

1. Cada jogador recebe 10 cartas brancas (respostas).
2. A cada rodada, um jogador é o juiz. Antes de revelar a pergunta, ele pode trocar cartas da própria mão (uma vez por rodada).
3. O juiz revela uma carta preta. Os outros escolhem a carta branca que completa a frase. Se a carta tiver duas lacunas, você escolhe duas cartas, na ordem em que entram na frase.
4. Quando todos respondem, as respostas aparecem embaralhadas e sem nome. O juiz escolhe a favorita, e quem mandou ganha 1 ponto.
5. As cartas usadas vão para o descarte, todo mundo completa a mão de volta para 10, e o juiz passa para o próximo.
6. Vence quem chegar primeiro aos pontos combinados (padrão: 5). Também tem o modo infinito.

## Cartas

- As cartas do jogo ficam em `cards.js`. Para adicionar mais, edite as listas `black` (perguntas, com `____` em cada lacuna) e `white` (respostas).
- No lobby, o anfitrião pode colar "cartas da casa" (uma por linha). Elas valem só para aquela sala.

## Se alguém cair

- Quem recarregar a página ou perder a conexão volta para a partida abrindo o mesmo link.
- Se o juiz ficar mais de 30 segundos desconectado, a rodada é pulada e o próximo vira juiz.
- Quem ficar mais de 30 segundos desconectado não trava a rodada. O juiz também pode clicar em "Seguir sem quem falta".
- Quem entrar no meio da partida joga a partir da próxima rodada.
