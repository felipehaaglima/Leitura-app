// Trechos de obras em domínio público, transcritos da Wikisource.
function readingPages(pages) {
  return pages.map((paragraphs) => ({
    blocks: paragraphs.map((text) => ({ type: "text", text })),
  }));
}

export const sampleBooks = [
  {
    id: "alienista",
    title: "O Alienista",
    author: "Machado de Assis",
    genre: "Novela",
    source: "https://pt.wikisource.org/wiki/O_Alienista",
    pages: readingPages([
      [
        "As chronicas da villa de Itaguahy dizem que em tempos remotos vivera alli um certo medico, o Dr. Simão Bacamarte, filho da nobreza da terra e o maior dos medicos do Brazil, de Portugal e das Hespanhas. Estudára em Coimbra e Padua. Aos trinta e quatro annos regressou ao Brazil, não podendo el‐rei alcançar delle que ficasse em Coimbra, regendo a universidade, ou em Lisboa, expedindo os negocios da monarchia.",
        "— A sciencia, disse elle a Sua Magestade, é o meu emprego unico; Itaguahy é o meu universo.",
        "Dito isto, metteu-se em Itaguahy, e entregou-se de corpo e alma ao estudo da sciencia, alternando as curas com as leituras, e demonstrando os theoremas com cataplasmas. Aos quarenta annos casou com D. Evarista da Costa e Mascarenhas, senhora de vinte e cinco annos, viuva de um juiz de fóra, e não bonita nem sympathica. Um dos tios delle, caçador de pacas perante o Eterno, e não menos franco, admirou‐se de semelhante escolha e disse-lh’o. Simão Bacamarte explicou‐lhe que D. Evarista reunia condições physiologicas e anatomicas de primeira ordem, digeria com facilidade, dormia regularmente, tinha bom pulso, e excellente vista; estava assim apta para dar‐lhe filhos robustos, sãos e intelligentes. Se além dessas prendas,— unicas dignas da preoccupação de um sabio, D. Evarista era mal composta de feições, longe de lastimal-o, agradecia-o a Deus, porquanto não corria o risco de preterir os interesses da sciencia na contemplação exclusiva, miuda e vulgar da consorte.",
      ],
      [
        "D. Evarista mentiu ás esperanças do Dr. Bacamarte, não lhe deu filhos robustos nem mofinos. A indole natural da sciencia é a longanimidade; o nosso medico esperou tres annos, depois quatro, depois cinco. Ao cabo desse tempo fez um estudo profundo da materia, releu todos os escriptores arabes e outros, que trouxera para Itaguahy, enviou consultas às universidades italianas e alemãs, e acabou por aconselhar à mulher um regímen alimentício especial. A ilustre dama, nutrida exclusivamente com a bela carne de porco de Itaguaí, não atendeu às admoestações do esposo; e à sua resistência,—explicável, mas inqualificável,— devemos a total extinção da dinastia dos Bacamartes.",
        "Mas a ciência tem o inefável dom de curar todas as mágoas; o nosso médico mergulhou inteiramente no estudo e na prática da medicina. Foi então que um dos recantos desta lhe chamou especialmente a atenção,—o recanto psíquico, o exame de patologia cerebral. Não havia na colônia, e ainda no reino, uma só autoridade em semelhante matéria, mal explorada, ou quase inexplorada. Simão Bacamarte compreendeu que a ciência lusitana, e particularmente a brasileira, podia cobrir-se de \"louros imarcescíveis\", — expressão usada por ele mesmo, mas em um arroubo de intimidade doméstica; exteriormente era modesto, segundo convém aos sabedores.",
        "—A saúde da alma, bradou ele, é a ocupação mais digna do médico.",
        "—Do verdadeiro médico, emendou Crispim Soares, boticário da vila, e um dos seus amigos e comensais.",
      ],
      [
        "A vereança de Itaguaí, entre outros pecados de que é arguida pelos cronistas, tinha o de não fazer caso dos dementes. Assim é que cada louco furioso era trancado em uma alcova, na própria casa, e, não curado, mas descurado, até que a morte o vinha defraudar do benefício da vida; os mansos andavam à solta pela rua. Simão Bacamarte entendeu desde logo reformar tão ruim costume; pediu licença à Câmara para agasalhar e tratar no edifício que ia construir todos os loucos de Itaguaí, e das demais vilas e cidades, mediante um estipêndio, que a Câmara lhe daria quando a família do enfermo o não pudesse fazer. A proposta excitou a curiosidade de toda a vila, e encontrou grande resistência, tão certo é que dificilmente se desarraigam hábitos absurdos, ou ainda maus. A ideia de meter os loucos na mesma casa, vivendo em comum, pareceu em si mesma um sintoma de demência e não faltou quem o insinuasse à própria mulher do médico.",
        "—Olhe, D. Evarista, disse-lhe o Padre Lopes, vigário do lugar, veja se seu marido dá um passeio ao Rio de Janeiro. Isso de estudar sempre, sempre, não é bom, vira o juízo.",
      ],
      [
        "D. Evarista ficou aterrada, foi ter com o marido, disse-lhe \"que estava com desejos\", um principalmente, o de vir ao Rio de Janeiro e comer tudo o que a ele lhe parecesse adequado a certo fim. Mas aquele grande homem, com a rara sagacidade que o distinguia, penetrou a intenção da esposa e redarguiu-lhe sorrindo que não tivesse medo. Dali foi à Câmara, onde os vereadores debatiam a proposta, e defendeu-a com tanta eloquência, que a maioria resolveu autorizá-lo ao que pedira, votando ao mesmo tempo um imposto destinado a subsidiar o tratamento, alojamento e mantimento dos doidos pobres. A matéria do imposto não foi fácil achá-la; tudo estava tributado em Itaguaí. Depois de longos estudos, assentou-se em permitir o uso de dois penachos nos cavalos dos enterros. Quem quisesse emplumar os cavalos de um coche mortuário pagaria dois tostões à Câmara, repetindo-se tantas vezes esta quantia quantas fossem as horas decorridas entre a do falecimento e a da última bênção na sepultura. O escrivão perdeu-se nos cálculos aritméticos do rendimento possível da nova taxa; e um dos vereadores, que não acreditava na empresa do médico, pediu que se relevasse o escrivão de um trabalho inútil.",
        "— Os cálculos não são precisos, disse ele, porque o Dr. Bacamarte não arranja nada. Quem é que viu agora meter todos os doidos dentro da mesma casa?",
      ],
      [
        "Enganava-se o digno magistrado; o médico arranjou tudo. Uma vez empossado da licença começou logo a construir a casa. Era na Rua Nova, a mais bela rua de Itaguaí naquele tempo; tinha cinquenta janelas por lado, um pátio no centro, e numerosos cubículos para os hóspedes. Como fosse grande arabista, achou no Corão que Maomé declara veneráveis os doidos, pela consideração de que Alá lhes tira o juízo para que não pequem. A ideia pareceu-lhe bonita e profunda, e ele a fez gravar no frontispício da casa; mas, como tinha medo ao vigário, e por tabela ao bispo, atribuiu o pensamento a Benedito VIII, merecendo com essa fraude, aliás pia, que o Padre Lopes lhe contasse, ao almoço, a vida daquele pontífice eminente.",
        "A Casa Verde foi o nome dado ao asilo, por alusão à cor das janelas, que pela primeira vez apareciam verdes em Itaguaí. Inaugurou-se com imensa pompa; de todas as vilas e povoações próximas, e até remotas, e da própria cidade do Rio de Janeiro, correu gente para assistir às cerimônias, que duraram sete dias. Muitos dementes já estavam recolhidos; e os parentes tiveram ocasião de ver o carinho paternal e a caridade cristã com que eles iam ser tratados. D. Evarista, contentíssima com a glória do marido, vestiu-se luxuosamente, cobriu-se de joias, flores e sedas. Ela foi uma verdadeira rainha naqueles dias memoráveis; ninguém deixou de ir visitá-la duas e três vezes, apesar dos costumes caseiros e recatados do século, e não só a cortejavam como a louvavam; porquanto,— e este fato é um documento altamente honroso para a sociedade do tempo, — porquanto viam nela a feliz esposa de um alto espírito, de um varão ilustre, e, se lhe tinham inveja, era a santa e nobre inveja dos admiradores.",
        "Ao cabo de sete dias expiraram as festas públicas; Itaguaí tinha finalmente uma casa de Orates.",
      ],
    ]),
  },
  {
    id: "cartomante",
    title: "A Cartomante",
    author: "Machado de Assis",
    genre: "Conto",
    source: "https://pt.wikisource.org/wiki/A_Cartomante",
    pages: readingPages([
      [
        "Hamlet observa a Horácio que há mais cousas no céu e na terra do que sonha a nossa filosofia. Era a mesma explicação que dava a bela Rita ao moço Camilo, numa sexta-feira de novembro de 1869, quando este ria dela, por ter ido na véspera consultar uma cartomante; a diferença é que o fazia por outras palavras.",
        "— Ria, ria. Os homens são assim; não acreditam em nada. Pois saiba que fui, e que ela adivinhou o motivo da consulta, antes mesmo que eu lhe dissesse o que era. Apenas começou a botar as cartas, disse-me: «A senhora gosta de uma pessoa...» Confessei que sim, e então ella continuou a botar as cartas, combinou-as, e no fim declarou-me que eu tinha medo de que você me esquecesse, mas que não era verdade...",
        "— Errou! interrompeu Camillo, rindo.",
        "— Não diga isso, Camillo. Se você soubesse como eu tenho andado, por sua causa. Você sabe; já lhe disse. Não ria de mim, não ria...",
        "Camilo pegou-lhe nas mãos, e olhou para ella sério e fixo. Jurou que lhe queria muito, que os seus sustos pareciam de criança; em todo o caso, quando tivesse algum receio, a melhor cartomante era elle mesmo. Depois, reprehendeu-a; disse-lhe que era imprudente andar por essas casas. Villela podia sabel-o, e depois...",
      ],
      [
        "— Qual saber! tive muita cautela, ao entrar na casa.",
        "— Onde é a casa?",
        "— Aqui perto, na Rua da Guarda Velha; não passava ninguém nessa ocasião. Descansa; eu não sou maluca.",
        "Camilo riu outra vez:",
        "— Tu crês deveras nessas cousas? perguntou-lhe.",
        "Foi então que ela, sem saber que traduzia Hamlet em vulgar, disse-lhe que havia muita cousa misteriosa e verdadeira neste mundo. Se ele não acreditava, paciência; mas o certo é que a cartomante adivinhara tudo. Que mais? A prova é que ela agora estava tranquila e satisfeita.",
        "Cuido que ele ia falar, mas reprimiu-se. Não queria arrancar-lhe as ilusões. Também ele, em criança, e ainda depois, foi supersticioso, teve um arsenal inteiro de crendices, que a mãe lhe incutiu, e que aos vinte anos desapareceram. No dia em que deixou cair toda essa vegetação parasita, e ficou só o tronco da religião, ele, como tivesse recebido da mãe ambos os ensinos, envolveu-os na mesma dúvida, e logo depois em uma só negação total. Camilo não acreditava em nada. Por quê? Não poderia dizê-lo, não possuía um só argumento; limitava-se a negar tudo. E digo mal, porque negar é ainda afirmar, e ele não formulava a incredulidade; diante do mistério, contentou-se em levantar os ombros, e foi andando.",
      ],
      [
        "Separaram-se contentes, ele ainda mais que ela. Rita estava certa de ser amada; Camilo, não só o estava, mas via-a estremecer e arriscar-se por ele, correr às cartomantes, e, por mais que a repreendesse, não podia deixar de sentir-se lisonjeado. A casa do encontro era na antiga Rua dos Barbonos, onde morava uma comprovinciana de Rita. Esta desceu pela Rua das Mangueiras, na direção de Botafogo, onde residia; Camilo desceu pela da Guarda Velha, olhando de passagem para a casa da cartomante.",
        "Vilela, Camilo e Rita, três nomes, uma aventura e nenhuma explicação das origens. Vamos a ela. Os dois primeiros eram amigos de infância. Vilela seguiu a carreira de magistrado. Camilo entrou no funcionalismo, contra a vontade do pai, que queria vê-lo médico; mas o pai morreu, e Camilo preferiu não ser nada, até que a mãe lhe arranjou um emprego público. No princípio de 1869, voltou Vilela da província, onde casara com uma dama formosa e tonta; abandonou a magistratura e veio abrir banca de advogado. Camilo arranjou-lhe casa para os lados de Botafogo, e foi a bordo recebê-lo.",
        "— É o senhor? exclamou Rita, estendendo-lhe a mão. Não imagina como meu marido é seu amigo; falava sempre do senhor.",
      ],
      [
        "Camilo e Vilela olharam-se com ternura. Eram amigos deveras. Depois, Camilo confessou de si para si que a mulher do Vilela não desmentia as cartas do marido. Realmente, era graciosa, viva nos gestos, olhos cálidos, boca fina e interrogativa. Era um pouco mais velha que ambos: contava trinta anos, Vilela vinte e nove e Camilo vinte e seis. Entretanto, o porte grave de Vilela fazia-o parecer mais velho que a mulher, enquanto Camilo era um ingênuo na vida moral e prática. Faltava-lhe tanto a ação do tempo, como os óculos de cristal, que a natureza põe no berço de alguns para adiantar os anos. Nem experiência, nem intuição.",
        "Uniram-se os três. Convivência trouxe intimidade. Pouco depois morreu a mãe de Camilo, e nesse desastre, que o foi, os dois mostraram-se grandes amigos dele. Vilela cuidou do enterro, dos sufrágios e do inventário; Rita tratou especialmente do coração, e ninguém o faria melhor.",
      ],
      [
        "Como daí chegaram ao amor, não o soube ele nunca. A verdade é que gostava de passar as horas ao lado dela; era a sua enfermeira moral, quase uma irmã, mas principalmente era mulher e bonita. Odor di femmina: eis o que ele aspirava nela, e em volta dela, para incorporá-lo em si próprio. Liam os mesmos livros, iam juntos a teatros e passeios. Camilo ensinou-lhe as damas e o xadrez, e jogavam às noites; — ela mal; — ele, para lhe ser agradável, pouco menos mal. Até aí as cousas. Agora a ação da pessoa, os olhos teimosos de Rita, que procuravam muita vez os dele, que os consultavam antes de o fazer ao marido, as mãos frias, as atitudes insólitas. Um dia, fazendo ele anos, recebeu de Vilela uma rica bengala de presente, e de Rita apenas um cartão com um vulgar cumprimento a lápis, e foi então que ele pôde ler no próprio coração; não conseguia arrancar os olhos do bilhetinho. Palavras vulgares; mas há vulgaridades sublimes, ou, pelo menos, deleitosas. A velha caleça de praça, em que pela primeira vez passeaste com a mulher amada, fechadinhos ambos, vale o carro de Apolo. Assim é o homem, assim são as cousas que o cercam.",
        "Camilo quis sinceramente fugir, mas já não pôde. Rita, como uma serpente, foi-se acercando dele, envolveu-o todo, fez-lhe estalar os ossos num espasmo, e pingou-lhe o veneno na boca. Ele ficou atordoado e subjugado. Vexame, sustos, remorsos, desejos, tudo sentiu de mistura; mas a batalha foi curta e a vitória delirante. Adeus, escrúpulos! Não tardou que o sapato se acomodasse ao pé, e aí foram ambos, estrada fora, braços dados, pisando folgadamente por cima de ervas e pedregulhos, sem padecer nada mais que algumas saudades, quando estavam ausentes um do outro. A confiança e estima de Vilela continuavam a ser as mesmas.",
      ],
    ]),
  },
  {
    id: "cidade",
    title: "A Cidade e as Serras",
    author: "Eça de Queirós",
    genre: "Romance",
    source: "https://pt.wikisource.org/wiki/A_cidade_e_as_serras_(1901)",
    pages: readingPages([
      [
        "O meu amigo Jacintho nasceu n’um palacio, com cento e nove contos de renda em terras de semeadura, de vinhedo, de cortiça e d’olival.",
        "No Alemtejo, pela Extremadura, atravez das duas Beiras, densas sebes ondulando por collina e valle, muros altos de boa pedra, ribeiras, estradas, delimitavam os campos d’esta velha familia agricola que já entulhava grão e plantava cepa em tempos d’el-rei D. Diniz. A sua quinta e casa senhorial de Tormes, no Baixo Douro, cobriam uma serra. Entre o Tua e o Tinhela, por cinco fartas legoas, todo o torrão lhe pagava fôro. E cerrados pinheiraes seus negrejavam desde Arga até ao mar d’Ancora. Mas o palacio onde Jacintho nascêra, e onde sempre habitára, era em Paris, nos Campos Elyseos, n.º 202.",
        "Seu avô, aquelle gordissimo e riquissimo Jacintho a quem chamavam em Lisboa o D. Galião, descendo uma tarde pela travessa da Trabuqueta, rente d’um muro de quintal que uma parreira toldava, escorregou n’uma casca de laranja e desabou no lagedo. Da portinha da horta sahia n’esse momento um homem moreno, escanhoado, de grosso casaco de baetão verde e botas altas de picador, que, galhofando e com uma força facil, levantou o enorme Jacintho — até lhe apanhou a bengala de castão d’ouro que rolára para o lixo. Depois, demorando n’elle os olhos pestanudos e pretos:",
        "— Oh Jacintho Galião, que andas tu aqui, a estas horas, a rebolar pelas pedras?",
        "E Jacintho, aturdido e deslumbrado, reconheceu o snr. Infante D. Miguel!",
      ],
      [
        "Desde essa tarde amou aquelle bom Infante como nunca amára, apesar de tão guloso, o seu ventre, e apesar de tão devoto o seu Deus! Na sala nobre da sua casa (á Pampulha) pendurou sobre os damascos o retrato do «seu Salvador», enfeitado de palmitos como um retabulo, e por baixo a bengala que as magnanimas mãos reaes tinham erguido do lixo. Emquanto o adoravel, desejado Infante penou no desterro de Vienna, o barrigudo senhor corria, sacudido na sua sege amarella, do botequim do Zé-Maria em Belem á botica do Placido nos Algibebes, a gemer as saudades do anginho, a tramar o regresso do anginho. No dia, entre todos bemdito, em que a Perola appareceu á barra com o Messias, engrinaldou a Pampulha, ergueu no Caneiro um monumento de papelão e lona onde D. Miguel, tornado S. Miguel, branco, d’aureola e azas de Archanjo, furava de cima do seu corcel d’Alter o Dragão do Liberalismo, que se estorcia vomitando a Carta. Durante a guerra com o «outro, com o pedreiro livre» mandava recoveiros a Santo Thyrso, a S. Gens, levar ao Rei fiambres, caixas de dôce, garrafas do seu vinho de Tarrafal, e bolsas de retroz atochadas de peças que elle ensaboava para lhes avivar o ouro. E quando soube que o snr. D. Miguel, com dois velhos bahus amarrados sobre um macho, tomára o caminho de Sines e do final desterro — Jacintho Galião correu pela casa, fechou todas as janellas como n’um luto, berrando furiosamente:",
        "— Tambem cá não fico! tambem cá não fico!",
      ],
      [
        "Não, não queria ficar na terra perversa d’onde partia, esbulhado e escorraçado, aquelle Rei de Portugal que levantava na rua os Jacinthos! Embarcou para França com a mulher, a snr.a D. Angelina Fafes (da tão fallada casa dos Fafes da Avellan); com o filho, o ’Cinthinho, menino amarellinho, mollesinho, coberto de caróços e leicenços; com a aia e com o moleque. Nas costas da Cantabria o paquete encontrou tão rijos mares que a snr.a D. Angelina, esguedelhada, de joelhos na enxerga do beliche, prometteu ao Senhor dos Passos d’Alcantara uma corôa d’espinhos, de ouro, com as gottas de sangue em rubis do Pegu. Em Bayonna, onde arribaram, ’Cinthinho teve ithericia. Na estrada d’Orleans, n’uma noite agreste, o eixo da berlinda em que jornadeavam partiu, e o nedio senhor, a delicada senhora da casa da Avellan, o menino, marcharam tres horas na chuva e na lama do exilio até uma aldeia, onde, depois de baterem como mendigos a portas mudas, dormiram nos bancos d’uma taberna. No «Hotel dos Santos Padres», em Paris, soffreram os terrores d’um fogo que rebentára na cavalhariça, sob o quarto de D. Galião, e o digno fidalgo, rebolando pelas escadas em camisa, até ao pateo, enterrou o pé nú numa lasca de vidro. Então ergueu amargamente ao céo o punho cabelludo, e rugiu:",
        "— Irra! É de mais!",
      ],
      [
        "Logo n’essa semana, sem escolher, Jacintho Galião comprou a um Principe polaco, que depois da tomada de Varsovia se mettera frade cartuxo, aquelle palacete dos Campos Elyseos, n.º 202. E sob o pesado ouro dos seus estuques, entre as suas ramalhudas sedas se enconchou, descançando de tantas agitações, n’uma vida de pachorra e de boa mesa, com alguns companheiros d’emigração (o desembargador Nuno Velho, o conde de Rabacena, outros menores), até que morreu de indigestão, d’uma lampreia d’escabeche que lhe mandára o seu procurador em Monte-mór. Os amigos pensavam que a snr.a D. Angelina Fafes voltaria ao reino. Mas a boa senhora temia a jornada, os mares, as caleças que racham. E não se queria separar do seu Confessor, nem do seu Medico, que tão bem lhe comprehendiam os escrupulos e a asthma.",
        "— Eu, por mim, aqui fico no 202 (declarára ella), ainda que me faz falta a boa agua d’Alcolena... O ’Cinthinho, esse, em crescendo, que decida.",
      ],
      [
        "O ’Cinthinho crescèra. Era um moço mais esguio e livido que um cirio, de longos cabellos corredios, narigudo, silencioso, encafuado em roupas pretas, muito largas e bambas; de noite, sem dormir, por causa da tosse e de suffocações, errava em camisa com uma lamparina atravez do 202; e os creados na copa sempre lhe chamavam a Sombra. N’essa sua mudez e indecisão de sombra surdira, ao fim do luto do papá, o gosto muito vivo de tornear madeiras ao torno: depois, mais tarde, com a melada flôr dos seus vinte annos, brotou n’elle outro sentimento, de desejo e de pasmo, pela filha do desembargador Velho, uma menina redondinha como uma rôla, educada n’um convento de Paris, e tão habilidosa que esmaltava, dourava, concertava relogios e fabricava chapéos de feltro. No outomno de 1851, quando já se desfolhavam os castanheiros dos Campos Elyseos, o ’Cinthinho cuspilhou sangue. O medico, acarinhando o queixo e com uma ruga seria na testa immensa, aconselhou que o menino abalasse para o golfo Juan ou para as tepidas areias d’Arcachon.",
        "’Cinthinho porém, no seu afèrro de sombra, não se quiz arredar da Therezinha Velho, de quem se tornára, atravez de Paris, a muda, tardônha sombra. Como uma sombra, casou; deu mais algumas voltas ao torno; cuspiu um resto de sangue; e passou, como uma sombra.",
        "Tres mezes e tres dias depois do seu enterro o meu Jacintho nasceu.",
        "Desde o berço, onde a avó espalhava funcho e ambar para afugentar a Sorte-Ruim, Jacintho medrou com a segurança, a rijeza, a seiva rica d’um pinheiro das dunas.",
      ],
    ]),
  },
];
